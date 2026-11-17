/*
 * Page composition: intro, table of contents, operation sections, search and hash navigation.
 */
import { clear, el, scrollTo, slug } from "./dom.js";
import { renderOperation } from "./operation.js";
import { state } from "./state.js";

function match(operation, tagName, query) {
  if (!query) return true;
  var haystack = [operation.operationId, operation.summary, operation.description, tagName, operation.tags && operation.tags.join(" ")].join(" ").toLowerCase();
  var path = (operation.__path || "").toLowerCase();
  var method = (operation.__method || "").toLowerCase();
  return query.split(/\s+/).every(function (word) {
    return haystack.indexOf(word) !== -1 || path.indexOf(word) !== -1 || method === word;
  });
}

function renderIntro(spec) {
  var intro = document.getElementById("intro");
  clear(intro);
  intro.appendChild(el("h1", { text: spec.info.title }));
  var paragraphs = String(spec.info.description || "").split("\n\n");
  paragraphs.forEach(function (paragraph) {
    intro.appendChild(el("p", { text: paragraph.replace(/\n/g, " ").replace(/\*\*/g, "") }));
  });

  // Credentials first: the most common integration mistake is using the wrong one.
  var schemes = (spec.components && spec.components.securitySchemes) || {};
  var schemeNames = Object.keys(schemes);
  if (schemeNames.length) {
    var table = el("table", { class: "params" }, [
      el("thead", {}, [el("tr", {}, [el("th", { text: "Scheme" }), el("th", { text: "Where" }), el("th", { text: "Use" })])]),
      el("tbody", {}, schemeNames.map(function (name) {
        var scheme = schemes[name];
        var where = scheme.type === "apiKey" ? "cookie " + scheme.name : scheme.type === "oauth2" ? "OAuth 2.0" : scheme.scheme + " " + (scheme.bearerFormat || "");
        return el("tr", {}, [
          el("td", {}, [el("code", { text: name })]),
          el("td", {}, [el("span", { class: "type", text: where })]),
          el("td", { text: scheme.description || "" }),
        ]);
      })),
    ]);
    intro.appendChild(el("div", { class: "block" }, [el("h3", { text: "Credentials" }), table]));
  }

  var dl = el("dl", {}, [
    el("div", {}, [el("dt", { text: "Version" }), el("dd", { text: spec.info.version })]),
    el("div", {}, [el("dt", { text: "OpenAPI" }), el("dd", { text: spec.openapi })]),
    el("div", {}, [el("dt", { text: "Base URL" }), el("dd", { text: state.baseUrl })]),
    el("div", {}, [el("dt", { text: "Document" }), el("dd", {}, [el("a", { href: "/v1/openapi.json", text: "/v1/openapi.json" })])]),
  ]);
  intro.appendChild(dl);
}

function renderToc(sections) {
  var toc = document.getElementById("toc");
  clear(toc);
  sections.forEach(function (section) {
    var group = el("div", { class: "toc-group" });
    var button = el("button", {
      class: "toc-tag",
      type: "button",
    }, [el("span", { text: section.name }), el("span", { class: "toc-count", text: String(section.entries.length) })]);
    button.addEventListener("click", function () {
      var target = document.getElementById("tag-" + slug(section.name));
      scrollTo(target, "start");
      Array.prototype.forEach.call(toc.querySelectorAll(".toc-tag"), function (node) {
        node.setAttribute("aria-current", node === button ? "true" : "false");
      });
    });
    group.appendChild(button);
    var ops = el("div", { class: "toc-ops" });
    section.entries.forEach(function (entry) {
      ops.appendChild(el("a", { class: "toc-op", href: "#" + entry.id, text: entry.operation.summary || entry.path }));
    });
    group.appendChild(ops);
    toc.appendChild(group);
  });
}

function renderSections(sections, query) {
  var root = document.getElementById("sections");
  clear(root);
  var shown = 0;
  sections.forEach(function (section) {
    if (!section.entries.length) return;
    var sectionNode = el("section", { class: "tag-section", id: "tag-" + slug(section.name) }, [
      el("div", { class: "tag-head" }, [
        el("h2", { text: section.name }),
        el("p", { text: section.description || "" }),
      ]),
    ]);
    section.entries.forEach(function (entry) {
      var node = renderOperation(entry.path, entry.method, entry.operation, section.name);
      node.id = entry.id;
      if (!match(Object.assign({ __path: entry.path, __method: entry.method }, entry.operation), section.name, query)) {
        node.classList.add("hidden");
      } else {
        shown += 1;
      }
      sectionNode.appendChild(node);
    });
    root.appendChild(sectionNode);
  });
  var count = document.getElementById("count");
  if (query) {
    count.textContent = shown + " of " + sections.reduce(function (total, section) { return total + section.entries.length; }, 0) + " operations match";
  } else {
    count.textContent = sections.reduce(function (total, section) { return total + section.entries.length; }, 0) + " operations · " + sections.length + " areas";
  }
  if (!shown && query) {
    root.appendChild(el("p", { class: "notice", text: "No operation matches “" + query + "”. Try a tag (users, webhooks) or a path fragment." }));
  }
}

function collectSections(spec) {
  var tagDescriptions = {};
  (spec.tags || []).forEach(function (tag) { tagDescriptions[tag.name] = tag.description; });
  var order = (spec.tags || []).map(function (tag) { return tag.name; });
  var byTag = {};
  Object.keys(spec.paths).forEach(function (path) {
    var item = spec.paths[path];
    Object.keys(item).forEach(function (method) {
      if (["parameters", "summary", "description", "servers", "$ref"].indexOf(method) !== -1) return;
      var operation = item[method];
      var tagName = (operation.tags && operation.tags[0]) || "Other";
      if (order.indexOf(tagName) === -1) order.push(tagName);
      (byTag[tagName] = byTag[tagName] || []).push({
        path: path,
        method: method,
        operation: operation,
        id: method + "-" + slug(path + "-" + operation.operationId),
      });
    });
  });
  return order
    .filter(function (name) { return byTag[name]; })
    .map(function (name) {
      byTag[name].sort(function (a, b) { return a.path.localeCompare(b.path) || a.method.localeCompare(b.method); });
      return { name: name, description: tagDescriptions[name] || "", entries: byTag[name] };
    });
}

function openFromHash() {
  var hash = window.location.hash.replace(/^#/, "");
  if (!hash) return;
  var node = document.getElementById(hash);
  if (!node || !node.classList.contains("op")) return;
  var head = node.querySelector(".op-head");
  if (head && head.getAttribute("aria-expanded") !== "true") head.click();
  scrollTo(node, "start");
}

/** Replaces the operations area with a single notice; used when the spec cannot be loaded. */
export function fail(message) {
  var root = document.getElementById("sections");
  clear(root);
  root.appendChild(el("p", { class: "notice", text: message }));
}

export function start(spec) {
  state.spec = spec;
  state.baseUrl = (spec.servers && spec.servers[0] && spec.servers[0].url) || window.location.origin;
  renderIntro(spec);
  var sections = collectSections(spec);
  renderToc(sections);
  renderSections(sections, "");
  var input = document.getElementById("q");
  var timer = null;
  input.addEventListener("input", function () {
    window.clearTimeout(timer);
    timer = window.setTimeout(function () {
      state.query = input.value.trim().toLowerCase();
      renderSections(sections, state.query);
    }, 120);
  });
  document.addEventListener("keydown", function (event) {
    if (event.key === "/" && document.activeElement !== input) {
      event.preventDefault();
      input.focus();
    }
  });
  window.addEventListener("hashchange", openFromHash);
  openFromHash();
}
