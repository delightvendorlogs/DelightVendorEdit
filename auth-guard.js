(function () {
  "use strict";

  var root = document.documentElement;
  var loaderStyle = document.createElement("style");
  loaderStyle.id = "dv-auth-loader-style";
  loaderStyle.textContent = "body{visibility:hidden!important}#dvAuthLoader{position:fixed;inset:0;z-index:2147483646;display:grid;place-content:center;gap:18px;padding:24px;background:linear-gradient(145deg,rgba(5,5,5,.97),rgba(19,17,12,.96));color:#f6f0df;text-align:center;font:13px/1.5 system-ui,sans-serif}#dvAuthLoader .dv-auth-brand{display:flex;align-items:center;justify-content:center;gap:10px;font-weight:700;letter-spacing:.2px}#dvAuthLoader img{width:34px;height:34px;object-fit:contain;animation:dvAuthPulse 1.1s ease-in-out infinite}#dvAuthLoader .dv-auth-copy{color:#cfc4a6;font-size:12px}#dvAuthLoader .dv-auth-track{width:min(220px,62vw);height:3px;margin:0 auto;overflow:hidden;border-radius:99px;background:#ffffff20}#dvAuthLoader .dv-auth-track:after{content:'';display:block;width:38%;height:100%;border-radius:99px;background:linear-gradient(90deg,#8f6b25,#f0d48b,#8f6b25);animation:dvAuthProgress 1.25s ease-in-out infinite}#dvAuthLoader .dv-auth-skeletons{display:grid;gap:7px;width:min(250px,70vw);margin:0 auto}#dvAuthLoader .dv-auth-skeletons i{display:block;height:7px;border-radius:9px;background:linear-gradient(90deg,#ffffff0b 20%,#ffffff20 48%,#ffffff0b 76%);background-size:220% 100%;animation:dvAuthShimmer 1.35s linear infinite}#dvAuthLoader .dv-auth-skeletons i:nth-child(2){width:78%;margin:auto}#dvAuthLoader .dv-auth-skeletons i:nth-child(3){width:55%;margin:auto}@keyframes dvAuthPulse{0%,100%{transform:scale(.88);opacity:.78}50%{transform:scale(1.08);opacity:1}}@keyframes dvAuthProgress{0%{transform:translateX(-120%)}100%{transform:translateX(360%)}}@keyframes dvAuthShimmer{to{background-position:-220% 0}}@media(prefers-reduced-motion:reduce){#dvAuthLoader *{animation:none!important}}#dvNavProgress{position:fixed;top:0;left:0;z-index:2147483647;height:3px;width:100%;pointer-events:none;opacity:0;transition:opacity .15s}#dvNavProgress:after{content:'';display:block;width:34%;height:100%;background:linear-gradient(90deg,transparent,#e3bd64,#fff0b8);box-shadow:0 0 9px #d8ad4d;transform:translateX(-120%)}#dvNavProgress.active{opacity:1}#dvNavProgress.active:after{animation:dvNavSweep .9s ease-in-out infinite}@keyframes dvNavSweep{to{transform:translateX(360%)}}";
  document.head.appendChild(loaderStyle);
  var authLoader = document.createElement("div");
  authLoader.id = "dvAuthLoader";
  authLoader.setAttribute("role","status");
  authLoader.setAttribute("aria-live","polite");
  authLoader.innerHTML = '<div class="dv-auth-brand"><img src="assets/dv-logo.png" alt=""><span>DelightVendorEdit</span></div><div class="dv-auth-copy">Preparing your account…</div><div class="dv-auth-track"></div><div class="dv-auth-skeletons" aria-hidden="true"><i></i><i></i><i></i></div>';
  root.appendChild(authLoader);
  var navProgress = document.createElement("div");
  navProgress.id = "dvNavProgress";
  root.appendChild(navProgress);

  // Never allow a failed or stalled authentication check to leave the whole site hidden.
  var authFailsafe = setTimeout(function () {
    finishAuthLoading();
    if (document.getElementById("dv-auth-failsafe")) return;
    var panel = document.createElement("section");
    panel.id = "dv-auth-failsafe";
    panel.setAttribute("role", "alert");
    panel.style.cssText = "position:fixed;z-index:2147483647;inset:0;display:grid;place-content:center;gap:14px;padding:24px;background:#080808;color:#f7f4ec;text-align:center;font:15px/1.6 system-ui,sans-serif";
    panel.innerHTML = '<div style="max-width:440px"><strong style="font-size:21px;color:#e7c56d">Still connecting…</strong><p style="color:#c8c1b2">The sign-in service is taking too long to respond. Your account and purchases have not been changed. Check your connection and try again.</p><button type="button" id="dv-auth-failsafe-retry" style="border:0;border-radius:10px;padding:12px 20px;background:#e7b84b;color:#171107;font-weight:800">Try again</button></div>';
    document.body.appendChild(panel);
    panel.querySelector("#dv-auth-failsafe-retry").addEventListener("click", function () { location.reload(); });
  }, 20000);
  function finishAuthLoading(){
    if(authFailsafe) clearTimeout(authFailsafe);
    if(authLoader.parentNode) authLoader.parentNode.removeChild(authLoader);
    loaderStyle.textContent = loaderStyle.textContent.replace("body{visibility:hidden!important}","");
    // Some protected pages hide the document root before this guard loads.
    // Clear that inline state after authentication so the page becomes visible.
    root.style.removeProperty("visibility");
  }
  function startNavigationProgress(){
    navProgress.classList.add("active");
  }
  document.addEventListener("click",function(event){
    var link=event.target && event.target.closest ? event.target.closest("a[href]") : null;
    if(!link || event.defaultPrevented || event.button!==0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || link.target==="_blank" || link.hasAttribute("download")) return;
    try{
      var destination=new URL(link.href,location.href);
      if(destination.origin!==location.origin) return;
      if(destination.pathname===location.pathname && destination.search===location.search && destination.hash) return;
      startNavigationProgress();
    }catch(_){}
  },true);
  window.addEventListener("beforeunload",startNavigationProgress);


  var base = new URL("./", location.href);
  var redirecting = false;

  function login() {
    if (redirecting) return;
    redirecting = true;
    var target = location.pathname + location.search + location.hash;
    location.replace(new URL("login.html?redirect=" + encodeURIComponent(target), base).href);
  }

  function showConnectionError(error) {
    console.warn("DelightVendorEdit could not verify the saved login session:", error);
    finishAuthLoading();

    var panel = document.createElement("section");
    panel.setAttribute("role", "alert");
    panel.style.cssText = "position:fixed;z-index:2147483647;inset:0;display:grid;place-content:center;gap:14px;padding:24px;background:#080808;color:#f7f4ec;text-align:center;font:15px/1.6 system-ui,sans-serif";
    panel.innerHTML = '<div style="max-width:440px"><div style="font-size:22px;font-weight:800;margin-bottom:8px">Connection problem</div><p style="color:#c8c1b2">We could not check your saved sign-in session because the connection or sign-in service did not respond. You have not been logged out. Please reconnect and try again.</p><button type="button" id="dve-auth-retry" style="border:0;border-radius:10px;padding:12px 20px;background:#e7b84b;color:#171107;font-weight:800">Try again</button><p style="margin-top:12px"><a href="' + new URL("login.html", base).href + '" style="color:#f5d47e">Return to sign in</a></p></div>';
    document.body.appendChild(panel);
    panel.querySelector("#dve-auth-retry").addEventListener("click", function () {
      location.reload();
    });
  }

  function withTimeout(promise, ms) {
    return Promise.race([promise, new Promise(function (_, reject) { setTimeout(function () { reject(new Error("Authentication request timed out.")); }, ms); })]);
  }

  function loadSdk() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      script.onload = resolve;
      script.onerror = function () { reject(new Error("The Supabase browser library could not load.")); };
      setTimeout(function () { reject(new Error("Timed out loading the Supabase browser library.")); }, 10000);
      document.head.appendChild(script);
    });
  }

  (async function () {
    try {
      try {
        var key = "sb-genlmqzkjouinofkitqt-auth-token";
        if (!localStorage.getItem(key) && localStorage.getItem("delightvendoredit-auth")) {
          localStorage.setItem(key, localStorage.getItem("delightvendoredit-auth"));
        }
      } catch (storageError) {
        // Supabase will report a storage problem below. Do not silently sign the user out.
        console.warn("Could not migrate the previous DelightVendorEdit session:", storageError);
      }

      await withTimeout(loadSdk(), 12000);

      var client = window.supabase.createClient(
        "https://genlmqzkjouinofkitqt.supabase.co",
        "sb_publishable_8uj618f_n35zeF3Fcyt5VA_xLHHOkNv",
        {
          auth: {
            persistSession: true,
            autoRefreshToken: true,
            detectSessionInUrl: true
          }
        }
      );

      // For a browser-only site, getSession reads the session persisted by the
      // login page. Avoid getUser() here: a temporary network failure during
      // its server request must not be mistaken for a signed-out customer.
      var result = await withTimeout(client.auth.getSession(), 12000);
      if (result.error) {
        showConnectionError(result.error);
        return;
      }

      if (!result.data || !result.data.session || !result.data.session.user) {
        login();
        return;
      }

      finishAuthLoading();

      client.auth.onAuthStateChange(function (event) {
        if (event === "SIGNED_OUT") login();
      });
    } catch (error) {
      showConnectionError(error);
    }
  })();
})();
