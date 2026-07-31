/* Shared mobile navigation menu. Builds the burger + dropdown from the page's
   own .nav-links anchors, so every locale keeps its labels and RTL order and
   the 26 templates never have to duplicate menu markup. Desktop is untouched:
   the burger only renders ≤720px (see navigation.css). */
(function () {
  "use strict";
  var nav = document.querySelector("nav.nav");
  if (!nav || nav.querySelector(".nav-burger")) return;
  var bar = nav.querySelector(".nav-in");
  var links = nav.querySelector(".nav-links");
  if (!bar || !links) return;

  var anchors = Array.prototype.filter.call(links.querySelectorAll("a"), function (a) {
    return !a.classList.contains("btn"); // the CTA stays visible in the bar
  });
  if (!anchors.length) return;

  var menu = document.createElement("div");
  menu.className = "nav-menu";
  menu.id = "nav-menu";
  anchors.forEach(function (a) {
    var c = a.cloneNode(true);
    c.classList.remove("hide-s", "hide-xs");
    menu.appendChild(c);
  });

  var burger = document.createElement("button");
  burger.type = "button";
  burger.className = "nav-burger";
  burger.setAttribute("aria-label", "Menu");
  burger.setAttribute("aria-expanded", "false");
  burger.setAttribute("aria-controls", "nav-menu");
  for (var i = 0; i < 3; i++) burger.appendChild(document.createElement("span"));

  bar.appendChild(burger);
  nav.appendChild(menu);

  function setOpen(open) {
    nav.classList.toggle("menu-open", open);
    burger.setAttribute("aria-expanded", open ? "true" : "false");
  }
  burger.addEventListener("click", function () {
    setOpen(!nav.classList.contains("menu-open"));
  });
  menu.addEventListener("click", function (e) {
    if (e.target && e.target.closest && e.target.closest("a")) setOpen(false);
  });
  document.addEventListener("click", function (e) {
    if (nav.classList.contains("menu-open") && !nav.contains(e.target)) setOpen(false);
  });
  document.addEventListener("keydown", function (e) {
    if (e.key === "Escape" && nav.classList.contains("menu-open")) {
      setOpen(false);
      burger.focus();
    }
  });
  var mq = window.matchMedia("(min-width: 721px)");
  var onChange = function (e) { if (e.matches) setOpen(false); };
  if (mq.addEventListener) mq.addEventListener("change", onChange);
  else mq.addListener(onChange);
})();
