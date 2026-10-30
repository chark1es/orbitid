/*
 * DOM helpers shared by the API reference viewer.
 *
 * Everything is built with DOM APIs and `textContent`, never `innerHTML`, so a hostile schema string cannot inject
 * markup. That is what lets the docs page run under `script-src 'self'` with no inline handlers and no `eval`.
 */

export function el(tag, attrs, children) {
  var node = document.createElement(tag);
  if (attrs) {
    Object.keys(attrs).forEach(function (key) {
      var value = attrs[key];
      if (value === null || value === undefined || value === false) return;
      if (key === "class") node.className = value;
      else if (key === "text") node.textContent = value;
      else if (key.slice(0, 2) === "on") node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value);
    });
  }
  (children || []).forEach(function (child) {
    if (child === null || child === undefined || child === false) return;
    node.appendChild(typeof child === "string" ? document.createTextNode(child) : child);
  });
  return node;
}

export function clear(node) {
  while (node.firstChild) node.removeChild(node.firstChild);
}

/** Scrolls a node into view; guarded so a non-rendering environment cannot break the handler. */
export function scrollTo(node, block) {
  if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: block || "start" });
}

export function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}
