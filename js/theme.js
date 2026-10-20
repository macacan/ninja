// Tema: följer systemet som standard. Användaren kan välja ljust eller mörkt med knappen i menyn/headern.
// Körs direkt i <head> så att sidan inte blinkar fel färg. Valet sparas i webbläsaren.
(() => {
  const link = document.getElementById("dark-css");
  const sys = matchMedia("(prefers-color-scheme: dark)");
  const read = () => { try { return localStorage.getItem("nl:theme"); } catch { return null; } };
  const dark = () => { const p = read(); return p ? p === "dark" : sys.matches; };
  function apply() {
    const p = read();
    const isDark = dark();
    if (link) link.media = p === "dark" ? "all" : p === "light" ? "not all" : "(prefers-color-scheme: dark)";
    document.documentElement.style.colorScheme = isDark ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", isDark ? "dark" : "light");
    document.querySelectorAll("[data-theme-toggle]").forEach((b) => {
      b.setAttribute("aria-pressed", isDark);
      b.querySelector("span") && (b.querySelector("span").textContent = isDark ? "Ljust läge" : "Mörkt läge");
    });
  }
  window.nlTheme = {
    dark,
    toggle() { try { localStorage.setItem("nl:theme", dark() ? "light" : "dark"); } catch {} apply(); },
    apply,
  };
  sys.addEventListener("change", apply);
  apply();
})();
