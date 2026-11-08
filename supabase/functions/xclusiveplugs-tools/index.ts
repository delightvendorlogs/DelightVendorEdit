import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const BASE="https://xclusiveplugs.com/api/v1";
const cors={"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, apikey, content-type, x-client-info","Access-Control-Allow-Methods":"POST, OPTIONS"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:{...cors,"Content-Type":"application/json"}});
const num=(v:any)=>{const n=Number(v);return Number.isFinite(n)&&n>=0?n:null};
function normalize(raw:any){const rows=Array.isArray(raw)?raw:(Array.isArray(raw?.data)?raw.data:(Array.isArray(raw?.tools)?raw.tools:(Array.isArray(raw?.data?.tools)?raw.data.tools:[])));return rows.map((x:any)=>({tool_id:String(x.tool_id??x.id??x.uuid??"").trim(),tool_name:String(x.name??x.title??x.tool_name??x.service_name??("Tool "+(x.id??""))).trim(),provider_price:num(x.price??x.cost??x.amount??x.provider_price??x.selling_price),provider_currency:String(x.currency??x.price_currency??"NGN"),image_url:x.image?(/^https?:\/\//i.test(String(x.image))?String(x.image):"https://xclusiveplugs.com"+(String(x.image).startsWith("/")?"":"/")+String(x.image)):null,provider_snapshot:x})).filter((x:any)=>x.tool_id)}
function calc(provider:number,g:any,i:any){const r=i&&i.pricing_mode!=="inherit"?i:g;const mode=r?.pricing_mode||"markup_amount";if(mode==="fixed")return num(r.fixed_price)??provider;if(mode==="markup_percent")return Math.ceil(provider*(1+Number(r.markup_percent||0)/100));if(mode==="markup_amount")return Math.ceil(provider+Number(r.markup_amount||0));return provider}
function providerError(parsed:any){if(!parsed||typeof parsed!=="object")return null;const s=String(parsed.status??"").toLowerCase();if(parsed.success===false||parsed.status===false||["error","failed","failure","rejected"].includes(s)||parsed.error||parsed.errors?.length)return String(parsed.error?.message??parsed.error??parsed.errors?.[0]?.message??parsed.message??"Provider rejected this order.");return null}
function hasDelivery(value:any):boolean{
 if(value===null||value===undefined)return false;
 if(typeof value==="string"){const text=value.trim();return !!text&&!/^(success|successful|completed|order (placed|created|submitted)|request (accepted|submitted))\b/i.test(text)}
 if(typeof value!=="object")return false;
 if(Array.isArray(value))return value.some(hasDelivery);
 const ignored=new Set(["status","success","message","error","errors","id","order_id","order_number","provider_order_id","provider_reference","reference","transaction_id","payment_reference","provider","provider_name","tool_id","tool_name","name","title","price","amount","currency","quantity","created_at","updated_at"]);
 return Object.entries(value).some(([key,val])=>!ignored.has(key.toLowerCase())&&hasDelivery(val));
}
Deno.serve(async(req)=>{
 if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
 if(req.method!=="POST")return reply({error:"POST required"},405);
 const url=Deno.env.get("SUPABASE_URL")!,anon=Deno.env.get("SUPABASE_ANON_KEY")!,service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!,auth=req.headers.get("Authorization")||"";
 const userDb=createClient(url,anon,{global:{headers:{Authorization:auth}}}),{data:{user},error:userErr}=await userDb.auth.getUser();
 if(userErr||!user)return reply({error:"Please sign in to continue."},401);
 const db=createClient(url,service),key=(Deno.env.get("XCLUSIVEPLUGS_API_KEY")||"").trim().replace(/^Bearer\s+/i,"");
 let input:any;try{input=await req.json()}catch{return reply({error:"Invalid request body."},400)}
 const action=String(input.action||"");
 const isAdmin=async()=>{const r=await userDb.rpc("is_admin");return !r.error&&r.data===true};
 async function providerTools(){if(!key)throw new Error("XclusivePlugs API key is not configured on the DVE server yet.");const r=await fetch(BASE+"/tools",{headers:{Authorization:"Bearer "+key,Accept:"application/json"}});const t=await r.text();let j:any;try{j=JSON.parse(t)}catch{j={message:t}}if(!r.ok)throw new Error(j?.message||j?.error||"Provider tools request failed ("+r.status+").");return normalize(j)}
 if(action==="catalog"){
  const [g,p,saved]=await Promise.all([
    db.from("xclusiveplugs_tools_settings").select("*").eq("id",true).maybeSingle(),
    db.from("xclusiveplugs_tool_pricing").select("*"),
    db.from("working_tool_inventory").select("tool_id,tool_name,provider_price,inventory_status").eq("inventory_status","available")
  ]);
  if(g.error||p.error||saved.error)return reply({error:"Could not load Working Tools pricing."},500);
  const map=new Map((p.data||[]).map((x:any)=>[String(x.tool_id),x]));
  let items:any[]=[];
  try{items=await providerTools()}catch(e){
    items=(saved||[]).map((x:any)=>({tool_id:x.tool_id,tool_name:x.tool_name,provider_price:Number(x.provider_price),provider_currency:"NGN",image_url:null,provider_snapshot:{}}));
    if(!items.length)return reply({error:String((e as Error).message||e),code:key?"PROVIDER_ERROR":"PROVIDER_KEY_MISSING"},503);
  }
  const byId=new Map(items.map((x:any)=>[String(x.tool_id),x]));
  for(const savedItem of (saved||[])){
    if(!byId.has(String(savedItem.tool_id))){
      const rule=map.get(String(savedItem.tool_id))||{};
      byId.set(String(savedItem.tool_id),{tool_id:savedItem.tool_id,tool_name:savedItem.tool_name,provider_price:Number(savedItem.provider_price),provider_currency:"NGN",image_url:rule.provider_snapshot?.image_url||null,provider_snapshot:rule.provider_snapshot||{}});
    }
  }
  const visible=[...byId.values()].filter((x:any)=>map.get(String(x.tool_id))?.enabled!==false);
  return reply({success:true,tools:visible.map((x:any)=>({...x,customer_price:x.provider_price===null?null:calc(x.provider_price,g.data,map.get(String(x.tool_id))),pricing_mode:map.get(String(x.tool_id))?.pricing_mode||"inherit"}))});
 }
 if(["admin_load","admin_save_global","admin_save_tool","admin_sync"].includes(action)){
  if(!await isAdmin())return reply({error:"Admin access required."},403);
  if(action==="admin_load"){const [g,p]=await Promise.all([db.from("xclusiveplugs_tools_settings").select("*").eq("id",true).maybeSingle(),db.from("xclusiveplugs_tool_pricing").select("*").order("tool_name")]);if(g.error||p.error)return reply({error:"Could not load admin pricing."},500);return reply({success:true,global_pricing:g.data,tools:p.data||[]})}
  if(action==="admin_save_global"){const v=input.settings||{},mode=String(v.pricing_mode||"");const row={id:true,pricing_mode:mode,fixed_price:mode==="fixed"?Number(v.fixed_price):null,markup_amount:Number(v.markup_amount||0),markup_percent:Number(v.markup_percent||0),updated_by:user.id,updated_at:new Date().toISOString()};if(!["fixed","markup_amount","markup_percent"].includes(mode)||[row.fixed_price,row.markup_amount,row.markup_percent].some((n:any)=>n!==null&&(!Number.isFinite(n)||n<0)))return reply({error:"Invalid global pricing values."},400);const r=await db.from("xclusiveplugs_tools_settings").upsert(row,{onConflict:"id"});if(r.error)return reply({error:r.error.message},500);return reply({success:true})}
  if(action==="admin_save_tool"){const v=input.tool||{},id=String(v.tool_id||"").trim(),name=String(v.tool_name||"").trim(),mode=String(v.pricing_mode||"inherit");if(!id||!name||!["inherit","fixed","markup_amount","markup_percent"].includes(mode))return reply({error:"Invalid tool pricing rule."},400);const row={tool_id:id,tool_name:name,pricing_mode:mode,fixed_price:mode==="fixed"?Number(v.fixed_price):null,markup_amount:Number(v.markup_amount||0),markup_percent:Number(v.markup_percent||0),enabled:v.enabled!==false,provider_price:num(v.provider_price),provider_currency:String(v.provider_currency||"NGN"),provider_snapshot:v.provider_snapshot||{},provider_synced_at:new Date().toISOString(),updated_by:user.id,updated_at:new Date().toISOString()};if([row.fixed_price,row.markup_amount,row.markup_percent].some((n:any)=>n!==null&&(!Number.isFinite(n)||n<0)))return reply({error:"Pricing values cannot be negative."},400);const r=await db.from("xclusiveplugs_tool_pricing").upsert(row,{onConflict:"tool_id"});if(r.error)return reply({error:r.error.message},500);return reply({success:true})}
  if(action==="admin_sync"){const items=await providerTools();for(const x of items){const old=await db.from("xclusiveplugs_tool_pricing").select("pricing_mode,fixed_price,markup_amount,markup_percent,enabled").eq("tool_id",x.tool_id).maybeSingle();const p=old.data||{};const r=await db.from("xclusiveplugs_tool_pricing").upsert({...x,pricing_mode:p.pricing_mode||"inherit",fixed_price:p.fixed_price??null,markup_amount:p.markup_amount??0,markup_percent:p.markup_percent??0,enabled:p.enabled??true,provider_synced_at:new Date().toISOString()},{onConflict:"tool_id"});if(r.error)return reply({error:r.error.message},500)}return reply({success:true,synced:items.length})}
 }
 if(action==="admin_inventory_list"){
  const check=await userClient.rpc("is_admin");
  if(check.error||check.data!==true)return reply({error:"Admin access required."},403);
  const listed=await db.from("working_tool_inventory").select("tool_id,tool_name,provider_price,delivery_payload,inventory_status,source_transaction_id,purchased_by,created_at,updated_at").order("updated_at",{ascending:false}).limit(300);
  if(listed.error)return reply({error:"Could not load saved Working Tools inventory."},500);
  return reply({success:true,items:listed.data||[]});
 }
 if(action==="purchase"){
  const toolId=String(input.tool_id||"").trim(),idem=String(input.idempotency_key||"").trim();
  if(!toolId||!idem||idem.length>100)return reply({error:"A tool and unique idempotency key are required."},400);
  const ref="XTOOLS-"+user.id.slice(0,8)+"-"+idem.replace(/[^a-zA-Z0-9_-]/g,"").slice(0,40);
  const prior=await db.from("wallet_transactions").select("id,status,amount,metadata").eq("reference",ref).maybeSingle();
  if(prior.data){const priorMeta=prior.data.metadata&&typeof prior.data.metadata==="object"?prior.data.metadata:{};return reply({success:prior.data.status==="completed",already_processed:true,status:prior.data.status,amount:prior.data.amount,metadata:priorMeta,delivery:priorMeta.delivery_payload||null,reference:ref})}
  const savedLookup=await db.from("working_tool_inventory").select("tool_id,tool_name,provider_price,delivery_payload,inventory_status,source_transaction_id").eq("tool_id",toolId).eq("inventory_status","available").maybeSingle();
  if(savedLookup.error)return reply({error:"Could not check saved Working Tools inventory."},500);
  const saved=savedLookup.data;
  let tool:any;
  if(saved){
    tool={tool_id:toolId,tool_name:saved.tool_name,provider_price:Number(saved.provider_price)};
  }else{
    let items:any[];try{items=await providerTools()}catch(e){return reply({error:String((e as Error).message||e)},503)}
    tool=items.find((x:any)=>x.tool_id===toolId);
    if(!tool)return reply({error:"This tool is no longer available. Refresh the catalogue."},404);
  }
  const [g,p]=await Promise.all([
    db.from("xclusiveplugs_tools_settings").select("*").eq("id",true).maybeSingle(),
    db.from("xclusiveplugs_tool_pricing").select("*").eq("tool_id",toolId).maybeSingle()
  ]);
  if(g.error||p.error)return reply({error:"Could not verify the current selling price."},500);
  if(p.data?.enabled===false)return reply({error:"This tool is currently unavailable."},403);
  const inventoryUsed=!!saved;
  const basePrice=inventoryUsed?Number(saved.provider_price):Number(tool.provider_price);
  if(!Number.isFinite(basePrice)||basePrice<=0)return reply({error:"The provider has not supplied a valid price for this tool."},422);
  if(!inventoryUsed&&!key)return reply({error:"Working Tools checkout is not ready: the provider connection is not configured."},503);
  const selling=calc(basePrice,g.data,p.data);if(!Number.isFinite(selling)||selling<=0)return reply({error:"This tool has no valid customer price."},422);
  const debit=await db.rpc("debit_product_wallet",{p_user_id:user.id,p_amount:selling,p_reference:ref,p_description:"Working Tools purchase — "+tool.tool_name});
  if(debit.error||!debit.data?.ok){const reason=debit.data?.reason;return reply({error:reason==="insufficient_balance"?"Insufficient funds in your wallet.":reason==="wallet_missing"?"Shopping wallet not found.":debit.error?.message||"Wallet debit failed."},reason==="insufficient_balance"?402:400)}
  const tx=debit.data.transaction_id;
  let result:any=saved?.delivery_payload??null;
  if(!inventoryUsed){
    const payload={tool_id:/^\d+$/.test(toolId)?Number(toolId):toolId,idempotency_key:idem};
    let response:Response;
    try{response=await fetch(BASE+"/tools/orders",{method:"POST",headers:{Authorization:"Bearer "+key,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(payload)})}
    catch(e){return reply({error:"The provider connection was interrupted. Your payment is being held for safe reconciliation; contact support with reference "+ref+".",reference:ref,transaction_id:tx},502)}
    const raw=await response.text();try{result=JSON.parse(raw)}catch{result={message:raw}};
    const fail=providerError(result);
    if(!response.ok||fail){const providerMessage=String(fail||result?.message||result?.error?.message||"");const providerInsufficient=/insufficient|not enough|low balance|insufficient funds/i.test(providerMessage)||response.status===402;await db.rpc("finish_product_wallet_purchase",{p_transaction_id:tx,p_success:false,p_note:"XclusivePlugs rejected order: "+(providerMessage||response.status)});return reply({error:providerInsufficient?"Insufficient funds. Please contact support.":(providerMessage||"Provider order failed. Your wallet has been refunded.")},502)}
  }

  const providerStatus=String(result?.status||result?.data?.status||"").toLowerCase();
  const providerPending=["pending","processing","queued","in_progress"].includes(providerStatus);
  const hasDeliveryResult=hasDelivery(result);
  const isPending=providerPending||!hasDeliveryResult;
  const meta={category:"working-tools",tool_id:toolId,title:tool.tool_name,customer_price:selling,delivery_payload:result,inventory_used:inventoryUsed,inventory_saved:!!saved||(!isPending&&hasDeliveryResult)};
  await db.from("wallet_transactions").update({metadata:meta,description:"Working Tools purchase — "+tool.tool_name}).eq("id",tx);

  let inventoryId=saved?.tool_id||null;
  if(!inventoryUsed&&!isPending&&hasDeliveryResult){
    const inventoryInsert=await db.from("working_tool_inventory").insert({
      tool_id:toolId,tool_name:tool.tool_name,provider_price:basePrice,delivery_payload:result,
      inventory_status:"available",source_transaction_id:tx,purchased_by:user.id,updated_at:new Date().toISOString()
    }).select("tool_id").maybeSingle();
    if(inventoryInsert.error){
      if(inventoryInsert.error.code==="23505"){
        const winner=await db.from("working_tool_inventory").select("tool_id,delivery_payload,provider_price").eq("tool_id",toolId).eq("inventory_status","available").maybeSingle();
        if(winner.data){result=winner.data.delivery_payload;inventoryId=winner.data.tool_id;meta.delivery_payload=result;meta.inventory_used=true;}
      }else console.error("Working Tools reusable inventory save failed",inventoryInsert.error.message);
    }else inventoryId=inventoryInsert.data?.tool_id||null;
  }
  meta.inventory_saved=!!inventoryId;

  await db.rpc("finish_product_wallet_purchase",{p_transaction_id:tx,p_success:true,p_note:"Working Tools purchase — "+tool.tool_name});
  await db.from("wallet_transactions").update({metadata:meta,description:"Working Tools purchase — "+tool.tool_name}).eq("id",tx);
  let orderId:string|null=null,orderNumber:string|null=null,itemId:string|null=null,orderRecorded=false;
  try{
    const order=await db.from("orders").insert({
      customer_user_id:user.id,order_status:isPending?"processing":"completed",payment_status:"verified",
      subtotal:selling,fees:0,total:selling,currency:"NGN",payment_provider:"wallet",
      payment_reference:ref,paid_at:new Date().toISOString(),completed_at:isPending?null:new Date().toISOString()
    }).select("id,order_number").single();
    if(order.error)throw order.error;
    orderId=order.data.id;orderNumber=order.data.order_number;
    const item=await db.from("order_items").insert({
      order_id:orderId,item_source:"xclusiveplugs_tool",provider_section:"working-tools",
      provider_item_reference:toolId,item_title_snapshot:tool.tool_name,quantity:1,unit_price:selling,
      platform_commission:0,seller_net_amount:0,fulfillment_status:isPending?"processing":"completed",
      delivery_payload:result
    }).select("id").single();
    if(item.error)throw item.error;
    itemId=item.data.id;orderRecorded=true;
    const profit=await db.rpc("queue_referral_profit_for_order_item",{
      p_order_item_id:itemId,p_provider_cost:inventoryUsed?0:basePrice,p_customer_price:selling
    });
    if(profit.error)console.error("Working Tools referral profit record failed",profit.error.message);
    await db.from("wallet_transactions").update({
      related_order_id:orderId,metadata:{...meta,order_id:orderId,order_number:orderNumber,delivery_payload:result}
    }).eq("id",tx);
  }catch(e){console.error("Working Tools order history save failed",String(e))}
  return reply({success:true,message:inventoryUsed?"Saved Working Tool inventory delivered.":isPending?"Working Tool payment succeeded; delivery is still processing.":"Working Tool order submitted.",delivery:result,customer_price:selling,provider_price:basePrice,inventory_used:inventoryUsed,inventory_saved:!!inventoryId,inventory_id:inventoryId,reference:ref,order_id:orderId,order_number:orderNumber,order_recorded:orderRecorded});

 }
 return reply({error:"Unknown action."},400);
});