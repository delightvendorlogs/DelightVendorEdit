(function () {
  "use strict";

  var root = document.documentElement;
  root.style.visibility = "hidden";

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
    root.style.visibility = "";

    var panel = document.createElement("section");
    panel.setAttribute("role", "alert");
    panel.style.cssText = "position:fixed;z-index:2147483647;inset:0;display:grid;place-content:center;gap:14px;padding:24px;background:#080808;color:#f7f4ec;text-align:center;font:15px/1.6 system-ui,sans-serif";
    panel.innerHTML = '<div style="max-width:440px"><div style="font-size:22px;font-weight:800;margin-bottom:8px">Connection problem</div><p style="color:#c8c1b2">We could not check your saved sign-in session because the connection or sign-in service did not respond. You have not been logged out. Please reconnect and try again.</p><button type="button" id="dve-auth-retry" style="border:0;border-radius:10px;padding:12px 20px;background:#e7b84b;color:#171107;font-weight:800">Try again</button><p style="margin-top:12px"><a href="' + new URL("login.html", base).href + '" style="color:#f5d47e">Return to sign in</a></p></div>';
    document.body.appendChild(panel);
    panel.querySelector("#dve-auth-retry").addEventListener("click", function () {
      location.reload();
    });
  }

  function loadSdk() {
    if (window.supabase && window.supabase.createClient) return Promise.resolve();
    return new Promise(function (resolve, reject) {
      var script = document.createElement("script");
      script.src = "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2";
      script.onload = resolve;
      script.onerror = function () { reject(new Error("The Supabase browser library could not load.")); };
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

      await loadSdk();

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
      var result = await client.auth.getSession();
      if (result.error) {
        showConnectionError(result.error);
        return;
      }

      if (!result.data || !result.data.session || !result.data.session.user) {
        login();
        return;
      }

      root.style.visibility = "";

      client.auth.onAuthStateChange(function (event) {
        if (event === "SIGNED_OUT") login();
      });
    } catch (error) {
      showConnectionError(error);
    }
  })();
})();
