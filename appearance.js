/* Shared DelightVendorEdit appearance preference */
(function () {
  try {
    var saved = localStorage.getItem("dve_appearance");
    var theme = saved === "light" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", theme);
    var meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute("content", theme === "light" ? "#f5f6f8" : "#080808");
    window.addEventListener("storage", function (event) {
      if (event.key === "dve_appearance") {
        var next = event.newValue === "light" ? "light" : "dark";
        document.documentElement.setAttribute("data-theme", next);
        if (meta) meta.setAttribute("content", next === "light" ? "#f5f6f8" : "#080808");
      }
    });
  } catch (error) {
    document.documentElement.setAttribute("data-theme", "dark");
  }
})();