import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const BASE = "https://thegiftunc.com/api";
const cors = { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info", "Access-Control-Allow-Methods": "GET, POST, OPTIONS" };
const reply = (body: unknown, status=200, headers: Record<string,string>={}) => new Response(JSON.stringify(body), {status,headers:{...cors,"Content-Type":"application/json",...headers}});

function providerFailureText(raw:string, parsed:any, httpOk:boolean): string|null {
  if (!httpOk) return raw || "Provider request failed.";
  const serialized = typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? {});
  if (/insufficient|low balance|not enough (?:credit|funds?|balance)|balance too low/i.test(serialized)) return serialized;
  if (parsed && typeof parsed === "object") {
    const status = String(parsed.status ?? "").toLowerCase();
    const hasErrors = Array.isArray(parsed.errors) ? parsed.errors.length > 0 : Boolean(parsed.errors);
    if (parsed.success === false || parsed.status === false || ["error","failed","failure","rejected"].includes(status) || hasErrors || (parsed.error !== undefined && parsed.error !== null && parsed.error !== "")) {
      return String(parsed.error?.message ?? parsed.error ?? parsed.errors?.[0]?.message ?? parsed.message ?? serialized);
    }
  }
  return null;
}

function isProviderBalanceFailure(raw:string, parsed:any):boolean {
  const serialized=(typeof parsed==="string"?parsed:JSON.stringify(parsed??{}))+" "+String(raw||"");
  return /insufficient|low balance|not enough (?:credit|funds?|balance)|balance too low|wallet balance (?:is )?(?:low|empty)|out of credits?/i.test(serialized);
}


function isProviderLowBalance(raw:string, parsed:any):boolean {
  const detail=(typeof parsed==="string"?parsed:JSON.stringify(parsed??{}))+" "+String(raw||"");
  return /insufficient|low balance|not enough (?:credit|funds?|balance)|(?:do not|don't|does not|doesn't) have enough (?:credit|funds?|balance)|balance (?:is )?(?:too low|insufficient)|wallet (?:balance )?(?:is )?(?:low|empty|insufficient)|(?:low|empty|insufficient) wallet|out of credits?/i.test(detail);
}

function customerProviderMessage(status:number, raw:string, parsed:any, workingProfilePurchase=false):string {
  if(isProviderLowBalance(raw,parsed)) return "Insufficient fund. Please contact support.";
  // TheGiftUNC's published Working Profile docs state that its insufficient-wallet
  // check throws a plain Error and is returned through its generic HTTP 500 handler.
  // That endpoint therefore cannot distinguish this known wallet failure by message.
  if(workingProfilePurchase && status===500) return "Insufficient fund. Please contact support.";
  if([401,403,404,408,429].includes(status)||status>=500) return "Temporary unavailable. Please contact support.";
  const message=String(parsed?.errors?.[0]?.message||parsed?.message||parsed?.error?.message||parsed?.error||"");
  return message && message.length<220 ? message : "Temporary unavailable. Please contact support.";
}

Deno.serve(async (req) => {
 if(req.method==="OPTIONS") return new Response("ok",{headers:cors});
 if(req.method!=="POST") return reply({error:"POST required"},405);
 const supabaseUrl=Deno.env.get("SUPABASE_URL")!;
 const anonKey=Deno.env.get("SUPABASE_ANON_KEY")!;
 const serviceKey=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
 const fallbackToken=Deno.env.get("THEGIFTUNC_API_KEY")||"";
 const auth=req.headers.get("Authorization")||"";
 const userClient=createClient(supabaseUrl,anonKey,{global:{headers:{Authorization:auth}}});
 const {data:{user},error:userError}=await userClient.auth.getUser();
 if(userError||!user) return reply({error:"Please sign in to continue."},401);
 const admin=createClient(supabaseUrl,serviceKey);
 let token=fallbackToken.trim().replace(/^Bearer\\s+/i,"");
 async function recordProviderPurchase(args:{userId:string;category:string;action:string;price:number;providerCost:number;reference:string;transactionId:string;title:string;providerRef:string|null;delivery:any}) {
   const metadata={category:args.category,provider_action:args.action,title:args.title,provider_reference:args.providerRef,customer_price:args.price,delivery_payload:args.delivery};
   try {
     const metaUpdate=await admin.from("wallet_transactions").update({metadata,description:"DelightVendorEdit "+args.category+" purchase — "+args.title}).eq("id",args.transactionId);
     if(metaUpdate.error) console.error("Could not save purchase metadata",metaUpdate.error.message);
   } catch(e) { console.error("Could not save purchase metadata",String(e)); }
   const now=new Date().toISOString();
   const providerStatus=String(args.delivery?.status||args.delivery?.result?.status||"").toLowerCase().replace(/[\s-]+/g,"_");
   const isPending=["pending","processing","queued","in_progress","waiting","created","submitted"].includes(providerStatus);
   let orderData:any=null;
   try {
     const orderInsert=await admin.from("orders").insert({
       customer_user_id:args.userId,order_status:isPending?"processing":"completed",payment_status:"verified",
       subtotal:args.price,fees:0,total:args.price,currency:"NGN",
       payment_provider:"wallet",payment_reference:args.reference,paid_at:now,completed_at:isPending?null:now
     }).select("id,order_number").single();
     if(orderInsert.error || !orderInsert.data) {
       console.error("Provider purchase order history insert failed",orderInsert.error?.message||"No order returned");
       return {orderId:null,orderNumber:null,recorded:false};
     }
     orderData=orderInsert.data;
   } catch(e) {
     console.error("Provider purchase order history insert threw",String(e));
     return {orderId:null,orderNumber:null,recorded:false};
   }
   let itemSaved=false;
   try {
     const itemInsert=await admin.from("order_items").insert({
       order_id:orderData.id,item_source:"thegiftunc_service",provider_section:args.category,
       provider_item_reference:args.providerRef,item_title_snapshot:args.title,quantity:1,
       unit_price:args.price,platform_commission:0,seller_net_amount:0,fulfillment_status:isPending?"processing":"completed",
       delivery_payload:args.delivery
     }).select("id").single();
     if(itemInsert.error) console.error("Provider purchase order item insert failed",itemInsert.error.message);
     else {
       itemSaved=true;
       const profitRecord=await admin.rpc("queue_referral_profit_for_order_item",{
         p_order_item_id:itemInsert.data.id,
         p_provider_cost:Math.max(0,Number(args.providerCost)||0),
         p_customer_price:Math.max(0,Number(args.price)||0)
       });
       if(profitRecord.error) console.error("Provider referral profit record failed",profitRecord.error.message);
     }
   } catch(e) { console.error("Provider purchase order item insert threw",String(e)); }
   try {
     const finalMetadata={...metadata,order_id:orderData.id,order_number:orderData.order_number};
     const txUpdate=await admin.from("wallet_transactions").update({
       related_order_id:orderData.id,metadata:finalMetadata
     }).eq("id",args.transactionId);
     if(txUpdate.error) console.error("Could not link wallet transaction to order",txUpdate.error.message);
   } catch(e) { console.error("Could not link wallet transaction to order",String(e)); }
   return {orderId:orderData.id,orderNumber:orderData.order_number,recorded:itemSaved};
 }
 let input:any;
 try { input=await req.json(); } catch { return reply({error:"Invalid request body."},400); }
 if(input.action==="providerTokenStatus" || input.action==="providerTokenSave") {
   const check=await userClient.rpc("is_admin");
   if(check.error || check.data!==true) return reply({error:"Admin access required."},403);
   if(input.action==="providerTokenStatus") return reply({success:true,configured:!!token,authType:"permanent_api_key"});
   return reply({error:"The permanent API key is managed only as the THEGIFTUNC_API_KEY Edge Function secret. This page cannot store credentials."},410);
 }
 
 const routes:Record<string,{method:string,path:string,category:string,purchase:boolean,pricePath?:string}> = {
  trackingPrice:{method:"GET",path:"/trackingNo/priceno",category:"tracking-number",purchase:false},
  trackingSearch:{method:"POST",path:"/trackingNo/search",category:"tracking-number",purchase:false},
  trackingReveal:{method:"POST",path:"/trackingNo/reveal",category:"tracking-number",purchase:true,pricePath:"/trackingNo/priceno"},
  trackingHistory:{method:"GET",path:"/trackingNo/history",category:"tracking-number",purchase:false},
  flightPrice:{method:"GET",path:"/flight-ticket/price",category:"flight-ticket",purchase:false},
  airlines:{method:"GET",path:"/flight-ticket/airlines",category:"flight-ticket",purchase:false},
  airportSearch:{method:"GET",path:"/flight-ticket/airport-search",category:"flight-ticket",purchase:false},
  flightsSearch:{method:"POST",path:"/flight-ticket/flights-search",category:"flight-ticket",purchase:false},
  flightBook:{method:"POST",path:"/flight-ticket/book",category:"flight-ticket",purchase:true,pricePath:"/flight-ticket/price"},
  flightHistory:{method:"GET",path:"/flight-ticket/history",category:"flight-ticket",purchase:false},
  profileList:{method:"GET",path:"/working-profile/list",category:"working-profile",purchase:false},
  profileDetail:{method:"GET",path:"/working-profile/",category:"working-profile",purchase:false},
  profilePurchase:{method:"POST",path:"/working-profile/purchase",category:"working-profile",purchase:true},
  aiPricing:{method:"GET",path:"/ai-studio/pricing",category:"ai-studio",purchase:false},
  aiVoices:{method:"GET",path:"/ai-studio/voices",category:"ai-studio",purchase:false},
  aiSwapFace:{method:"POST",path:"/ai-studio/swap-face",category:"ai-studio",purchase:true,pricePath:"/ai-studio/pricing"},
  aiSwapVideo:{method:"POST",path:"/ai-studio/swap-face-video",category:"ai-studio",purchase:true,pricePath:"/ai-studio/pricing"},
  aiLipsync:{method:"POST",path:"/ai-studio/lipsync",category:"ai-studio",purchase:true,pricePath:"/ai-studio/pricing"},
  aiHistory:{method:"GET",path:"/ai-studio/history",category:"ai-studio",purchase:false},
  aiGeneration:{method:"GET",path:"/ai-studio/",category:"ai-studio",purchase:false},
  serviceCategories:{method:"GET",path:"/service/categories",category:"services",purchase:false},
  serviceList:{method:"GET",path:"/service/list",category:"services",purchase:false},
  serviceDetail:{method:"GET",path:"/service/",category:"services",purchase:false},
  servicePurchase:{method:"POST",path:"/service/purchase",category:"services",purchase:true}
 };

 if(input.action==="workingProfileInventoryList" || input.action==="workingProfileInventorySetAvailable") {
   const check=await userClient.rpc("is_admin");
   if(check.error || check.data!==true) return reply({error:"Admin access required."},403);
   if(input.action==="workingProfileInventoryList") {
     const listed=await admin.from("working_profile_inventory").select("id,provider_profile_id,profile_title,provider_base_price,delivery_payload,inventory_status,source_transaction_id,purchased_by,delivered_to,reservation_user_id,reserved_at,created_at,delivered_at,available_marked_at,delivery_transaction_id").order("created_at",{ascending:false}).limit(200);
     if(listed.error) return reply({error:"Could not load Working Profile inventory: "+listed.error.message},500);
     return reply({success:true,items:listed.data||[]});
   }
   const id=String(input.body?.id||"").trim();
   const available=input.body?.available;
   if(!id || typeof available!=="boolean") return reply({error:"A valid inventory ID and availability value are required."},400);
   const patch=available
     ? {inventory_status:"available",reservation_user_id:null,reserved_at:null,available_marked_at:new Date().toISOString()}
     : {inventory_status:"delivered",reservation_user_id:null,reserved_at:null,available_marked_at:null};
   const changed=await admin.from("working_profile_inventory").update(patch).eq("id",id).in("inventory_status",["available","delivered"]).select("id,inventory_status").maybeSingle();
   if(changed.error) return reply({error:"Could not update inventory: "+changed.error.message},500);
   if(!changed.data) return reply({error:"That inventory item is currently reserved or no longer exists. Refresh the list."},409);
   return reply({success:true,item:changed.data});
 }

 if(input.action==="serviceAdminSync" || input.action==="serviceAdminList" || input.action==="serviceAdminUpdate") {
   const check=await userClient.rpc("is_admin"); if(check.error||check.data!==true) return reply({error:"Admin access required."},403);
   if(input.action==="serviceAdminSync") {
     const [cr,lr]=await Promise.all([
       fetch(BASE+"/service/categories",{headers:{Accept:"application/json"}}),
       fetch(BASE+"/service/list",{headers:{Accept:"application/json"}})
     ]);
     const [ct,lt]=await Promise.all([cr.text(),lr.text()]);
     let cats:any=ct,list:any=lt;
     try{cats=JSON.parse(ct)}catch{}
     try{list=JSON.parse(lt)}catch{}
     const unwrap=(value:any,keys:string[]):any[]=>{
       if(Array.isArray(value))return value;
       if(!value||typeof value!=="object")return [];
       for(const key of keys){const found=unwrap(value[key],keys);if(found.length)return found;}
       return [];
     };
     if(!cr.ok||!lr.ok){
       console.error("TheGiftUNC service catalogue request failed",JSON.stringify({categoriesStatus:cr.status,servicesStatus:lr.status,categoriesPreview:ct.slice(0,500),servicesPreview:lt.slice(0,1000)}));
       return reply({error:"TheGiftUNC rejected the catalogue request.",providerStatus:!cr.ok?cr.status:lr.status,providerDetails:(!cr.ok?ct:lt).slice(0,500)},502);
     }
     const categoryRows=unwrap(cats,["categories","result","data","items"]);
     const services=unwrap(list,["services","items","result","data"]);
     if(!services.length){
       console.error("TheGiftUNC returned no services",JSON.stringify({categoryCount:categoryRows.length,categoriesShape:Object.keys(cats||{}),servicesShape:Object.keys(list||{}),servicesPreview:lt.slice(0,1200)}));
       return reply({error:"TheGiftUNC catalogue returned 0 services. The provider response format or active catalogue needs checking.",categories:categoryRows.length,services:0,providerPreview:lt.slice(0,700)},502);
     }
     const categoryMap=new Map(categoryRows.map((c:any)=>[String(c.id??c.categoryId??c.category_id),String(c.name??c.title??"Other")]));
     const rows=services.filter((x:any)=>x&&(x.id!==undefined||x.serviceId!==undefined||x.service_id!==undefined)&&x.isActive!==false&&String(x.status||"").toLowerCase()!=="inactive").map((x:any)=>{
       const id=x.id??x.serviceId??x.service_id;
       const categoryId=x.categoryId??x.category_id??x.category?.id??"";
       return {service_id:String(id),category_id:String(categoryId),category_name:String(x.category?.name??x.categoryName??x.category_name??categoryMap.get(String(categoryId))??"Other"),name:String(x.name??x.title??x.serviceName??("Service "+id)),base_price:Math.max(0,Number(x.basePrice??x.base_price??x.price??x.amount??0)||0),service_fields:Array.isArray(x.fields)?x.fields:Array.isArray(x.requiredFields)?x.requiredFields:Array.isArray(x.serviceFields)?x.serviceFields:Array.isArray(x.formFields)?x.formFields:[],raw_data:x};
     });
     if(!rows.length)return reply({error:"The provider returned services, but none had a usable service ID.",providerServices:services.length,providerPreview:lt.slice(0,700)},502);
     let saved=0,failed=0;
     for(const row of rows){
       const {error}=await admin.from("thegiftunc_services").upsert({...row,updated_at:new Date().toISOString()},{onConflict:"service_id"});
       if(error){failed++;console.error("Service catalogue sync row failed",JSON.stringify({id:row.service_id,message:error.message}));}
       else saved++;
     }
     if(!saved)return reply({error:"The services were received but none could be saved to the local catalogue.",providerServices:services.length,saveFailures:failed},500);
     return reply({success:true,categories:categoryRows.length,providerServices:services.length,services:saved,saveFailures:failed});
   }
   if(input.action==="serviceAdminList") { const q=await admin.from("thegiftunc_services").select("service_id,category_id,category_name,name,base_price,pricing_mode,fixed_price,markup_percent,enabled,service_fields,updated_at").order("category_name").order("name"); if(q.error)return reply({error:"Could not load services."},500); return reply({success:true,services:q.data||[]}); }
   const b=input.body||{}, id=String(b.serviceId||""); if(!id)return reply({error:"Service ID is required."},400);
   const patch:any={enabled:!!b.enabled,pricing_mode:b.pricingMode==="fixed"?"fixed":"markup",fixed_price:b.pricingMode==="fixed"?Number(b.fixedPrice):null,markup_percent:Number(b.markupPercent||0),updated_at:new Date().toISOString()};
   if(!Number.isFinite(patch.markup_percent)||patch.markup_percent<0||patch.markup_percent>10000||(patch.pricing_mode==="fixed"&&(!Number.isFinite(patch.fixed_price)||patch.fixed_price<0)))return reply({error:"Enter a valid selling price or markup."},400);
   const changed=await admin.from("thegiftunc_services").update(patch).eq("service_id",id).select("service_id").maybeSingle(); if(changed.error||!changed.data)return reply({error:"Could not save service settings."},500); return reply({success:true});
 }
 const route=routes[input.action];
 if(!route) return reply({error:"Unsupported action."},400);
 let path=route.path;
 if(input.action==="airportSearch") {
   const keyword=String(input.query||"").trim();
   if(!keyword) return reply({error:"Enter an airport or city to search."},400);
   path += "?keyword="+encodeURIComponent(keyword);
 }
 if(input.action==="serviceDetail") { const id=String(input.id||"").trim(); if(!id||id.includes("/")||id.includes("..")) return reply({error:"A valid service ID is required."},400); path+=encodeURIComponent(id); }
 if(input.action==="profileDetail"||input.action==="aiGeneration") {
   const id=String(input.id||"").trim();
   if(!id||id.includes("/")||id.includes("..")) return reply({error:"A valid item ID is required."},400);
   path += id;
 }
 if(input.action==="flightsSearch") {
   const b=input.body&&typeof input.body==="object"?input.body:{};
   const origin=String(b.origin||"").trim().toUpperCase();
   const destination=String(b.destination||"").trim().toUpperCase();
   const parseDate=(value:any)=>{
     const raw=String(value||"").trim();
     const slash=raw.split("/");
     const dash=raw.split("-");
     if(slash.length===3&&slash.every(x=>x.length>0))return {day:Number(slash[0]),month:Number(slash[1]),year:Number(slash[2])};
     if(dash.length===3&&dash.every(x=>x.length>0))return {day:Number(dash[2]),month:Number(dash[1]),year:Number(dash[0])};
     return null;
   };
   const formatDate=(value:any)=>{
     const parts=parseDate(value);if(!parts)return null;
     const date=new Date(Date.UTC(parts.year,parts.month-1,parts.day));
     if(date.getUTCFullYear()!==parts.year||date.getUTCMonth()!==parts.month-1||date.getUTCDate()!==parts.day)return null;
     return {formatted:String(parts.day).padStart(2,"0")+"/"+String(parts.month).padStart(2,"0")+"/"+parts.year,key:parts.year+"-"+String(parts.month).padStart(2,"0")+"-"+String(parts.day).padStart(2,"0")};
   };
   const departure=formatDate(b.departureDate),returning=b.returnDate?formatDate(b.returnDate):null;
   const adults=Number(b.adults??1),children=Number(b.children??0),infants=Number(b.infants??0);
   if(!/^[A-Z]{3}$/.test(origin)||!/^[A-Z]{3}$/.test(destination)||origin===destination)return reply({error:"Choose two different valid 3-letter airport codes."},400);
   if(!departure)return reply({error:"Enter a valid departure date."},400);
   if(b.returnDate&&!returning)return reply({error:"Enter a valid return date."},400);
   if(returning&&returning.key<=departure.key)return reply({error:"Return date must be after departure date."},400);
   if(!Number.isInteger(adults)||!Number.isInteger(children)||!Number.isInteger(infants)||adults<1||children<0||infants<0||adults+children+infants>9||infants>adults)return reply({error:"Enter valid passenger counts: 1–9 travellers, with no more infants than adults."},400);
   input.body={...b,origin,destination,departureDate:departure.formatted,returnDate:returning?.formatted||undefined,adults,children,infants};
 }
 const publicActions=["trackingPrice","flightPrice","airlines","airportSearch","flightsSearch","profileList","profileDetail","aiPricing","aiVoices","serviceList","serviceCategories","serviceDetail"]; if(!token&&!publicActions.includes(input.action)) return reply({error:"The provider API key is not configured. Please contact support."},503);
 if(input.action==="aiVoices") {
   let voiceResponse:Response;
   let voiceRaw="";
   try {
     voiceResponse=await fetch(BASE+"/ai-studio/voices",{method:"GET",headers:{Accept:"application/json"}});
     voiceRaw=await voiceResponse.text();
   } catch(e) {
     console.error("TheGiftUNC AI Studio voices request failed",e instanceof Error?e.message:String(e));
     return reply({error:"Could not load provider voices. Please try again."},502);
   }
   let voiceData:any=voiceRaw;
   try { voiceData=JSON.parse(voiceRaw); } catch {}
   if(!voiceResponse!.ok) {
     console.error("TheGiftUNC AI Studio voices endpoint rejected request",JSON.stringify({status:voiceResponse!.status,preview:voiceRaw.slice(0,500)}));
     return reply({error:"The provider could not return its voice list right now.",providerStatus:voiceResponse!.status},502);
   }
   const voices=Array.isArray(voiceData)?voiceData:
     Array.isArray(voiceData?.result)?voiceData.result:
     Array.isArray(voiceData?.data)?voiceData.data:
     Array.isArray(voiceData?.voices)?voiceData.voices:[];
   if(!Array.isArray(voices)) return reply({error:"The provider returned an invalid voice list."},502);
   console.log("TheGiftUNC AI Studio voices loaded",JSON.stringify({count:voices.length}));
   return reply({result:voices});
 }
 if(input.action==="serviceList" || input.action==="serviceCategories") {
   const q=await admin.from("thegiftunc_services").select("service_id,category_id,category_name,name,base_price,pricing_mode,fixed_price,markup_percent,service_fields").eq("enabled",true).order("category_name").order("name");
   if(q.error)return reply({error:"Could not load available services."},503);
   const rows=(q.data||[]).map((x:any)=>({...x,sellingPrice:Math.ceil(x.pricing_mode==="fixed"?Number(x.fixed_price):Number(x.base_price)*(1+Number(x.markup_percent||0)/100))}));
   if(input.action==="serviceCategories") return reply({result:[...new Map(rows.map((x:any)=>[x.category_id||x.category_name,{id:x.category_id||x.category_name,name:x.category_name}])).values()]});
   return reply({result:rows.map((x:any)=>({service_id:x.service_id,category_id:x.category_id,category_name:x.category_name,name:x.name,sellingPrice:x.sellingPrice,service_fields:x.service_fields}))});
 }
 const pricingResult=await admin.from("product_pricing").select("pricing_mode,fixed_price,markup_percent,enabled").eq("category",route.category).maybeSingle();
 const pricing=pricingResult.data;
 if(pricingResult.error) return reply({error:"Pricing is temporarily unavailable. Please contact support."},503);
 if(pricing?.enabled===false && route.purchase) return reply({error:"This category is temporarily unavailable. Please contact support."},503);

 if(input.action==="servicePurchase") {
   const serviceId=String(input.body?.serviceId||"").trim();
   if(!serviceId) return reply({error:"Choose a valid service."},400);
   const found=await admin.from("thegiftunc_services").select("*").eq("service_id",serviceId).eq("enabled",true).maybeSingle();
   if(found.error||!found.data) return reply({error:"This service is unavailable. Please refresh the services list."},404);
   const service=found.data, base=Number(service.base_price||0), quantity=Math.max(1,Math.min(1000,Number(input.body?.quantity||1)));
   const unit=service.pricing_mode==="fixed"?Number(service.fixed_price):Math.ceil(base*(1+Number(service.markup_percent||0)/100));
   const total=Math.ceil(unit*quantity);
   if(!Number.isFinite(base)||base<0||!Number.isFinite(total)||total<=0) return reply({error:"This service price is not configured correctly. Please contact support."},503);
   const orderData=input.body?.orderData&&typeof input.body.orderData==="object"?input.body.orderData:{};
   const fields=Array.isArray(service.service_fields)?service.service_fields:[];
   const missing=fields.filter((f:any)=>f&&f.required&&!String(orderData[f.name||f.key||f.externalFieldId]??"").trim());
   if(missing.length) return reply({error:"Complete the required service details: "+missing.map((f:any)=>f.label||f.name||f.key).join(", ")},400);
   if(!token) return reply({error:"The supplier API credential is not configured. Please contact support."},503);
   const reference="DVE-"+crypto.randomUUID();
   const debit=await admin.rpc("debit_product_wallet",{p_user_id:user.id,p_amount:total,p_reference:reference,p_description:"DelightVendorEdit service purchase — "+service.name});
   if(debit.error) return reply({error:"Unable to process wallet payment. Please contact support."},500);
   if(!debit.data?.ok) return reply({error:debit.data?.reason==="insufficient_balance"?"Insufficient fund. Please fund wallet.":"Your wallet is not ready. Please contact support.",required:total,balance:debit.data?.balance},402);
   const transactionId=debit.data.transaction_id;
   try {
     const providerResponse=await fetch(BASE+"/service/purchase",{method:"POST",headers:{Authorization:"Bearer "+token,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify({serviceId,orderData,quantity}),signal:AbortSignal.timeout(45000)});
     const raw=await providerResponse.text(); let result:any=raw; try{result=JSON.parse(raw)}catch{}
     const failure=providerFailureText(raw,result,providerResponse.ok);
     if(!providerResponse.ok||failure) {
       console.error("TheGiftUNC service purchase rejected",JSON.stringify({status:providerResponse.status,serviceId,message:String(failure||raw).slice(0,300),responsePreview:String(raw||"").slice(0,700)}));
       if(isProviderBalanceFailure(raw,result)) {
         let rollback=await admin.rpc("discard_failed_product_wallet_purchase",{p_transaction_id:transactionId});
         if(rollback.error||!rollback.data?.ok) rollback=await admin.rpc("discard_failed_product_wallet_purchase",{p_transaction_id:transactionId});
         if(rollback.error||!rollback.data?.ok) console.error("Provider-insufficient wallet rollback needs support review.",rollback.error?.message||rollback.data);
         return reply({error:"Insufficient fund. Please contact support.",walletRestored:!rollback.error&&!!rollback.data?.ok,purchaseRecorded:false,providerStatus:providerResponse.status},402);
       }
       await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"TheGiftUNC service purchase failed: "+String(failure||raw).slice(0,300)});
       const customerMessage=providerResponse.status===401?"Supplier authentication failed. Please ask admin to check the TheGiftUNC API credential.":providerResponse.status===403?"The supplier has denied access to this service. Please contact support.":customerProviderMessage(providerResponse.status,raw,result);
       return reply({error:customerMessage,walletRefundRequested:true,providerStatus:providerResponse.status},502);
     }
     const delivery=result?.result??result?.data??result;
     const recorded=await recordProviderPurchase({userId:user.id,category:"services",action:"servicePurchase",price:total,providerCost:base*quantity,reference,transactionId,title:service.name,providerRef:serviceId,delivery});
     await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:true,p_note:"Completed service purchase — "+service.name});
     return reply({success:true,result:delivery,sellingPrice:total,transactionId,orderId:recorded.orderId,orderNumber:recorded.orderNumber,orderRecorded:recorded.recorded});
   } catch(e) {
     console.error("TheGiftUNC service purchase request exception",JSON.stringify({serviceId,message:e instanceof Error?e.message:String(e)}));
     await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"TheGiftUNC service request failed; automatic refund"});
     const timedOut=e instanceof Error&&(/timeout|abort/i.test(e.name+" "+e.message));
     return reply({error:timedOut?"The supplier did not respond in time. Your wallet refund has been requested. Please contact support.":"The supplier request failed. Your wallet refund has been requested. Please contact support."},502);
   }
 }
 if(input.action==="profilePurchase") {
   const profileId=String(input.body?.profileId||"").trim();
   if(!profileId || profileId.includes("/") || profileId.includes("..")) return reply({error:"A valid Working Profile ID is required."},400);
   const staleBefore=new Date(Date.now()-10*60*1000).toISOString();
   await admin.from("working_profile_inventory").update({inventory_status:"available",reservation_user_id:null,reserved_at:null}).eq("inventory_status","reserved").lt("reserved_at",staleBefore);
   let claimed:any=null;
   let listingItem:any=null;
   let base=NaN;
   let title=profileId;
   const stock=await admin.from("working_profile_inventory").select("*").eq("provider_profile_id",profileId).eq("inventory_status","available").order("created_at",{ascending:true}).limit(1).maybeSingle();
   if(stock.error) {
     console.error("Working Profile inventory lookup failed",stock.error.message);
     return reply({error:"Could not check saved Working Profile inventory. Please try again."},503);
   }
   if(stock.data) {
     const claim=await admin.from("working_profile_inventory").update({inventory_status:"reserved",reservation_user_id:user.id,reserved_at:new Date().toISOString()}).eq("id",stock.data.id).eq("inventory_status","available").select("*").maybeSingle();
     if(claim.error) {
       console.error("Working Profile inventory reserve failed",claim.error.message);
       return reply({error:"Could not reserve saved inventory. Please try again."},503);
     }
     claimed=claim.data||null;
   }
   if(claimed) {
     base=Number(claimed.provider_base_price);
     title=String(claimed.profile_title||profileId);
     if(!Number.isFinite(base)||base<=0) {
       await admin.from("working_profile_inventory").update({inventory_status:"available",reservation_user_id:null,reserved_at:null}).eq("id",claimed.id).eq("inventory_status","reserved");
       claimed=null;
     }
   }
   if(!claimed) {
     let listingResponse:Response;
     let listingRaw="";
     try {
       listingResponse=await fetch(BASE+"/working-profile/"+encodeURIComponent(profileId),{headers:{Authorization:"Bearer "+token,Accept:"application/json"}});
       listingRaw=await listingResponse.text();
     } catch(e) {
       return reply({error:"Could not verify this profile's current price. Please try again."},502);
     }
     let listingParsed:any=listingRaw;
     try { listingParsed=JSON.parse(listingRaw); } catch {}
     if(!listingResponse!.ok) return reply({error:customerProviderMessage(listingResponse!.status,listingRaw,listingParsed)},502);
     listingItem=listingParsed?.result??listingParsed?.data??listingParsed;
     if(Array.isArray(listingItem)) listingItem=listingItem.find((x:any)=>String(x?.id)===profileId)||listingItem[0];
     base=Number(listingItem?.sellingPrice??listingItem?.selling_price??listingItem?.price??listingItem?.cost??listingItem?.amount);
     title=String(listingItem?.title||listingItem?.name||profileId);
     if(!Number.isFinite(base)||base<=0) return reply({error:"The provider price for this profile could not be read. Please contact support."},502);
   }
   let finalPrice=pricing?.pricing_mode==="fixed" ? Number(pricing.fixed_price) : base*(1+Number(pricing?.markup_percent||0)/100);
   finalPrice=Math.ceil(finalPrice);
   if(!Number.isFinite(finalPrice)||finalPrice<=0) {
     if(claimed) await admin.from("working_profile_inventory").update({inventory_status:"available",reservation_user_id:null,reserved_at:null}).eq("id",claimed.id).eq("inventory_status","reserved");
     return reply({error:"The customer price is not configured correctly. Please contact support."},503);
   }
   const reference="DVE-"+crypto.randomUUID();
   const debit=await admin.rpc("debit_product_wallet",{p_user_id:user.id,p_amount:finalPrice,p_reference:reference,p_description:"DelightVendorEdit working-profile purchase"});
   if(debit.error || !debit.data?.ok) {
     if(claimed) await admin.from("working_profile_inventory").update({inventory_status:"available",reservation_user_id:null,reserved_at:null}).eq("id",claimed.id).eq("inventory_status","reserved");
     if(debit.error) return reply({error:"Unable to process wallet payment. Please contact support."},500);
     if(debit.data?.reason==="insufficient_balance") return reply({error:"Insufficient fund. Please fund wallet.",required:finalPrice,balance:debit.data.balance},402);
     return reply({error:"Your wallet is not ready. Please fund your wallet or contact support."},400);
   }
   const transactionId=debit.data.transaction_id;
   let delivery:any;
   let inventoryId:string|null=null;
   let inventorySaved=true;
   if(claimed) {
     delivery=claimed.delivery_payload;
     const mark=await admin.from("working_profile_inventory").update({inventory_status:"delivered",reservation_user_id:null,reserved_at:null,delivered_to:user.id,delivered_at:new Date().toISOString(),delivery_transaction_id:String(transactionId)}).eq("id",claimed.id).eq("inventory_status","reserved").select("id").maybeSingle();
     if(mark.error || !mark.data) {
       await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"Could not finalize reserved Working Profile inventory; automatic refund"});
       await admin.from("working_profile_inventory").update({inventory_status:"available",reservation_user_id:null,reserved_at:null}).eq("id",claimed.id).eq("inventory_status","reserved");
       return reply({error:"Saved inventory could not be finalized. Your wallet refund has been requested; please check your balance before trying again."},500);
     }
     inventoryId=claimed.id;
   } else {
     try {
       const providerResponse=await fetch(BASE+"/working-profile/purchase",{method:"POST",headers:{Authorization:"Bearer "+token,Accept:"application/json","Content-Type":"application/json"},body:JSON.stringify(input.body||{})});
       const raw=await providerResponse.text();
       let parsed:any=raw;
       try { parsed=JSON.parse(raw); } catch {}
       const providerFailure=providerFailureText(raw,parsed,providerResponse.ok);
       if(!providerResponse.ok || providerFailure) {
         const providerMessage=customerProviderMessage(providerResponse.status,raw,parsed,true);
         console.error("TheGiftUNC Working Profile purchase rejected",JSON.stringify({
           status:providerResponse.status,
           message:providerMessage,
           responsePreview:String(raw||"").slice(0,500)
         }));
         // TheGiftUNC documents a generic HTTP 500 for insufficient Working Profile wallet funds.
         // Restore the customer's debit and remove the temporary purchase row atomically.
         const providerBalanceFailure=isProviderBalanceFailure(raw,parsed)||providerResponse.status===500;
         if(providerBalanceFailure) {
           let rollback=await admin.rpc("discard_failed_product_wallet_purchase",{p_transaction_id:transactionId});
           if(rollback.error||!rollback.data?.ok) rollback=await admin.rpc("discard_failed_product_wallet_purchase",{p_transaction_id:transactionId});
           if(rollback.error||!rollback.data?.ok) console.error("Working Profile provider-insufficient rollback needs support review.",rollback.error?.message||rollback.data);
           return reply({error:"Insufficient fund. Please contact support.",walletRestored:!rollback.error&&!!rollback.data?.ok,purchaseRecorded:false,providerStatus:providerResponse.status},402);
         }
         await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"Provider rejected Working Profile purchase: "+String(providerFailure||raw||"HTTP "+providerResponse.status).slice(0,300)});
         return reply({error:providerMessage,walletRefundRequested:true,providerStatus:providerResponse.status},502);
       }
       delivery=parsed?.result??parsed?.data??parsed;
       const saved=await admin.from("working_profile_inventory").insert({provider_profile_id:profileId,profile_title:title,provider_base_price:base,delivery_payload:delivery,inventory_status:"delivered",source_transaction_id:String(transactionId),purchased_by:user.id,delivered_to:user.id,delivered_at:new Date().toISOString(),delivery_transaction_id:String(transactionId)}).select("id").single();
       if(saved.error) {
         inventorySaved=false;
         console.error("Working Profile delivery inventory save failed",JSON.stringify({message:saved.error.message,code:saved.error.code,profileId}));
       } else inventoryId=saved.data.id;
     } catch(e) {
       await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"Working Profile provider request failed; automatic refund"});
       return reply({error:"Temporary unavailable. Please contact support. Your wallet refund has been requested."},502);
     }
   }
   const profileOrder=await recordProviderPurchase({
     userId:user.id,category:route.category,action:input.action,price:finalPrice,providerCost:claimed?0:base,reference,transactionId,
     title,providerRef:profileId,delivery
   });
   await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:true,p_note:(claimed?"Delivered saved inventory for ":"Purchased and delivered ")+title});
   return reply({success:true,result:delivery,sellingPrice:finalPrice,transactionId,inventoryUsed:!!claimed,inventoryId,inventorySaved,orderId:profileOrder.orderId,orderNumber:profileOrder.orderNumber,orderRecorded:profileOrder.recorded,notice:!inventorySaved?"Purchase succeeded, but the delivery record could not be saved to admin inventory.":!profileOrder.recorded?"Purchase succeeded; it is still visible in Transactions while order history is being reconciled.":undefined});
 }

 let sellingPrice:number|undefined;
 let providerPrice:any=null;
 if(route.purchase) {
   try {
    if(route.pricePath) {
      const pr=await fetch(BASE+route.pricePath,{headers:{Authorization:"Bearer "+token,Accept:"application/json"}});
      const priceRaw=await pr.text();
      try { providerPrice=JSON.parse(priceRaw); } catch { providerPrice=Number(priceRaw); }
      if(!pr.ok) {
        console.error("Provider price endpoint failed", JSON.stringify({action:input.action,path:route.pricePath,status:pr.status,bodyPreview:priceRaw.slice(0,500)}));
        return reply({error:"Temporary unavailable. Please contact support.",providerStatus:pr.status},502);
      }
      console.log("Provider price response", JSON.stringify({action:input.action,path:route.pricePath,status:pr.status,contentType:pr.headers.get("content-type"),shape:providerPrice&&typeof providerPrice==="object"?Object.keys(providerPrice):typeof providerPrice,bodyPreview:priceRaw.slice(0,350)}));
    }
    const pickPrice=(v:any,keys:string[]):number=>{if(typeof v==="number"||typeof v==="string"){const n=Number(v);return Number.isFinite(n)?n:NaN}if(!v||typeof v!=="object")return NaN;for(const k of keys){const n=Number(v[k]);if(v[k]!==undefined&&v[k]!==null&&Number.isFinite(n)&&n>0)return n}for(const k of ["data","result","pricing","prices"])if(v[k]&&typeof v[k]==="object"){const n=pickPrice(v[k],keys);if(Number.isFinite(n))return n}return NaN};
    let base=pickPrice(providerPrice,["price","trackingNo","trackingNumber","tracking_no","amount","cost","sellingPrice","selling_price"]);
    if(input.action==="aiSwapFace") base=pickPrice(providerPrice,["swapFace","swap_face","imageFaceSwap","price"]);
    if(input.action==="aiSwapVideo") base=pickPrice(providerPrice,["swapFaceVideo","swap_face_video","videoFaceSwap","price"]);
    if(input.action==="aiLipsync") base=pickPrice(providerPrice,["lipsync","lipSync","lip_sync","price"]);
    if(input.action==="profilePurchase") {
      const listing=await fetch(BASE+"/working-profile/"+encodeURIComponent(String(input.body?.profileId||"")),{headers:{Authorization:"Bearer "+token,Accept:"application/json"}});
      if(!listing.ok) { const raw=await listing.text(); let parsed:any=raw; try{parsed=JSON.parse(raw)}catch{} return reply({error:customerProviderMessage(listing.status,raw,parsed)},502); }
      const item=await listing.json(); base=Number(item?.sellingPrice);
    }
    const fixedMode=pricing?.pricing_mode==="fixed";
    const fixedAmount=Number(pricing?.fixed_price);
    const hasValidFixedPrice=fixedMode&&Number.isFinite(fixedAmount)&&fixedAmount>0;
    if((!Number.isFinite(base)||base<=0)&&!hasValidFixedPrice) {
      console.error("Provider price could not be parsed", JSON.stringify({action:input.action,path:route.pricePath,responseType:providerPrice===null?"null":typeof providerPrice,responseKeys:providerPrice&&typeof providerPrice==="object"?Object.keys(providerPrice):[]}));
      return reply({error:"The provider price response could not be read. Please contact support with this message.",providerStatus:200},502);
    }
    if(!Number.isFinite(base)||base<0) base=0;
    sellingPrice=hasValidFixedPrice ? fixedAmount : base*(1+Number(pricing?.markup_percent||0)/100);
    sellingPrice=Math.ceil(sellingPrice);
    const reference="DVE-"+crypto.randomUUID();
    const debit=await admin.rpc("debit_product_wallet",{p_user_id:user.id,p_amount:sellingPrice,p_reference:reference,p_description:"DelightVendorEdit "+route.category+" purchase"});
    if(debit.error) return reply({error:"Unable to process wallet payment. Please contact support."},500);
    if(!debit.data?.ok) {
      if(debit.data?.reason==="insufficient_balance") return reply({error:"Insufficient fund. Please fund wallet.",required:sellingPrice,balance:debit.data.balance},402);
      return reply({error:"Your wallet is not ready. Please fund your wallet or contact support."},400);
    }
    const transactionId=debit.data.transaction_id;
    try {
      const providerResponse=await fetch(BASE+path,{method:route.method,headers:{Authorization:"Bearer "+token,Accept:"application/json",...(route.method==="POST"?{"Content-Type":"application/json"}:{})},...(route.method==="POST"?{body:JSON.stringify(input.body||{})}:{})});
      const contentType=providerResponse.headers.get("content-type")||"application/json";
      if(!providerResponse.ok && contentType.includes("application/pdf")) {
        const raw=await providerResponse.text();
        await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"Provider rejected purchase: "+raw.slice(0,300)});
        return reply({error:customerProviderMessage(providerResponse.status,raw,{}),walletRefundRequested:true},502);
      }
      if(contentType.includes("application/pdf") && providerResponse.ok) {
        const bytes=new Uint8Array(await providerResponse.arrayBuffer());
        let binary=""; for(let i=0;i<bytes.length;i++) binary+=String.fromCharCode(bytes[i]);
        const pdfDelivery={contentType,filename:"flight-ticket.pdf"};
        const pdfTitle="Flight Ticket PDF";
        await recordProviderPurchase({userId:user.id,category:route.category,action:input.action,price:sellingPrice!,providerCost:base,reference,transactionId,title:pdfTitle,providerRef:String(input.body?.flightId||input.body?.id||input.body?.flightNumber||"" )||null,delivery:pdfDelivery});
        await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:true,p_note:"Completed "+route.category+" purchase"});
        return reply({success:true,contentType,filename:"flight-ticket.pdf",base64:btoa(binary),sellingPrice,transactionId});
      }
      const raw=await providerResponse.text();
      let result:any=raw;
      try { result=JSON.parse(raw); } catch {}
      const providerFailure=providerFailureText(raw,result,providerResponse.ok);
      if(providerFailure) {
        if(isProviderLowBalance(raw,result)) {
          let rollback=await admin.rpc("discard_failed_product_wallet_purchase",{p_transaction_id:transactionId});
          if(rollback.error||!rollback.data?.ok) rollback=await admin.rpc("discard_failed_product_wallet_purchase",{p_transaction_id:transactionId});
          if(rollback.error||!rollback.data?.ok) console.error("Provider-insufficient wallet rollback needs support review.",rollback.error?.message||rollback.data);
          return reply({error:"Insufficient fund. Please contact support.",walletRestored:!rollback.error&&!!rollback.data?.ok,purchaseRecorded:false},402);
        }
        await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"Provider rejected purchase: "+providerFailure.slice(0,300)});
        return reply({error:customerProviderMessage(providerResponse.status,raw,result),walletRefundRequested:true},502);
      }
      const titleMap:Record<string,string>={"tracking-number":"Tracking Number","flight-ticket":"Flight Ticket","ai-studio":"AI Studio"};
      const title=String(result?.result?.title||result?.data?.title||result?.title||result?.name||titleMap[route.category]||route.category);
      const providerRef=String(input.body?.profileId||input.body?.flightId||input.body?.flight_id||input.body?.trackingNo||input.body?.trackingNumber||input.body?.id||"")||null;
      const purchaseOrder=await recordProviderPurchase({userId:user.id,category:route.category,action:input.action,price:sellingPrice!,providerCost:base,reference,transactionId,title,providerRef,delivery:result});
      await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:true,p_note:"Completed "+route.category+" purchase"});
      return reply({success:true,result,sellingPrice,transactionId,orderId:purchaseOrder.orderId,orderNumber:purchaseOrder.orderNumber,orderRecorded:purchaseOrder.recorded});
    } catch(e) {
      await admin.rpc("finish_product_wallet_purchase",{p_transaction_id:transactionId,p_success:false,p_note:"Provider request failed; automatic refund"});
      return reply({error:"Temporary unavailable. Please contact support. Your wallet refund has been requested."},502);
    }
   } catch(e) { return reply({error:"Unable to verify the current price. Please contact support."},503); }
 }
 let response:Response;
 let raw="";
 try {
   const requestHeaders={...(publicActions.includes(input.action)?{}:{Authorization:"Bearer "+token}),Accept:"application/json",...(route.method==="POST"?{"Content-Type":"application/json"}:{})};
   const requestBody=input.body||{};
   const requestOptions:any={method:route.method,headers:requestHeaders,...(route.method==="POST"?{body:JSON.stringify(requestBody)}:{})};
   if(input.action==="flightsSearch") requestOptions.signal=AbortSignal.timeout(45000);
   response=await fetch(BASE+path,requestOptions);
   raw=await response.text();

   
 } catch(e) {
   console.error("Provider request network exception", JSON.stringify({action:input.action,path,message:e instanceof Error?e.message:String(e)}));
   return reply({error:"Temporary unavailable. Please contact support."},502);
 }
 console.log("Provider request result", JSON.stringify({action:input.action,path,status:response.status,...(input.action==="flightsSearch"?{requestBody:{origin:input.body?.origin,destination:input.body?.destination,departureDate:input.body?.departureDate,returnDate:input.body?.returnDate,adults:input.body?.adults,children:input.body?.children,infants:input.body?.infants}}:{}),...(!response.ok?{contentType:response.headers.get("content-type"),bodyPreview:raw.slice(0,700)}:{})}));
 let result:any=raw; try{result=JSON.parse(raw)}catch{}
 if(!response.ok) return reply({error:customerProviderMessage(response.status,raw,result),providerStatus:response.status},502);
 return reply({result,providerPrice:result,category:route.category,pricing:pricing||{pricing_mode:"markup",markup_percent:0}});
});