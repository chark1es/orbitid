/*
 * OrbitID API reference viewer.
 *
 * Vanilla JS, one file, no dependencies: fetches /v1/openapi.json, groups operations by tag, and renders collapsible
 * operations with parameter tables, schema trees and copyable curl examples. Everything is built with DOM APIs and
 * textContent, never innerHTML, so a hostile schema string cannot inject markup. This is what lets the page run under
 * a strict CSP (`script-src 'self'`, no inline handlers, no eval).
 */
(function () {
  "use strict";

  var state = { spec: null, query: "", baseUrl: "" };

  // ───────────────────────────── DOM helpers ─────────────────────────────
  function el(tag, attrs, children) {
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

  function clear(node) {
    while (node.firstChild) node.removeChild(node.firstChild);
  }

  /** Scrolls a node into view; guarded so a non-rendering environment cannot break the handler. */
  function scrollTo(node, block) {
    if (node && typeof node.scrollIntoView === "function") node.scrollIntoView({ block: block || "start" });
  }

  function slug(text) {
    return String(text)
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
  }

  function resolve(ref) {
    if (!ref || ref.indexOf("#/") !== 0) return null;
    return ref
      .slice(2)
      .split("/")
      .map(function (part) {
        return part.replace(/~1/g, "/").replace(/~0/g, "~");
      })
      .reduce(function (node, part) {
        return node && node[part];
      }, state.spec);
  }

  // ───────────────────────────── schema rendering ─────────────────────────────
  var MAX_DEPTH = 6;

  function typeLabel(schema) {
    if (!schema || typeof schema !== "object") return "any";
    if (schema.$ref) return schema.$ref.split("/").pop();
    if (schema.const !== undefined) return JSON.stringify(schema.const);
    if (schema.enum) return schema.enum.slice(0, 6).map(function (v) { return JSON.stringify(v); }).join(" | ");
    if (schema.anyOf) return schema.anyOf.map(typeLabel).join(" | ");
    if (schema.oneOf) return schema.oneOf.map(typeLabel).join(" | ");
    if (schema.allOf) return schema.allOf.map(typeLabel).join(" & ");
    if (Array.isArray(schema.type)) return schema.type.join(" | ");
    if (schema.type === "array") return "array<" + typeLabel(schema.items) + ">";
    if (schema.type === "object") {
      if (schema.additionalProperties && schema.additionalProperties !== true && typeof schema.additionalProperties === "object") {
        return "map<" + typeLabel(schema.additionalProperties) + ">";
      }
      return "object";
    }
    var base = schema.type || "any";
    if (schema.format) return base + " (" + schema.format + ")";
    return base;
  }

  function isObjectSchema(schema) {
    return schema && typeof schema === "object" && (schema.type === "object" || schema.properties);
  }

  function schemaNode(schema, depth, name, required) {
    if (!schema || typeof schema !== "object") return el("span", { class: "empty", text: "any" });

    var target = schema;
    if (schema.$ref) {
      var resolved = resolve(schema.$ref);
      var link = el("span", {
        class: "type link",
        text: schema.$ref.split("/").pop(),
        title: schema.$ref,
        role: "link",
        tabindex: "0",
      });
      function jump() {
        var id = "schema-" + slug(schema.$ref.split("/").pop());
        var node = document.getElementById(id);
        if (node) {
          node.open = true;
          scrollTo(node, "center");
          node.classList.add("flash");
          window.setTimeout(function () { node.classList.remove("flash"); }, 1200);
        }
      }
      link.addEventListener("click", jump);
      link.addEventListener("keydown", function (event) {
        if (event.key === "Enter" || event.key === " ") { event.preventDefault(); jump(); }
      });
      var wrapper = el("div", { class: "prop" }, [
        name ? el("span", { class: "name", text: name }) : null,
        required ? el("span", { class: "req", text: "required", title: "required" }) : null,
        link,
      ]);
      if (schema.description) wrapper.appendChild(el("span", { class: "doc", text: schema.description }));
      return wrapper;
    }

    var complex = isObjectSchema(target) && target.properties && Object.keys(target.properties).length;
    var itemsComplex = target.type === "array" && target.items && (isObjectSchema(target.items) || target.items.$ref || target.items.anyOf);
    var anyComplex = (target.anyOf || target.oneOf) && (target.anyOf || target.oneOf).some(function (s) { return isObjectSchema(s) || s.$ref; });

    if ((complex || itemsComplex || anyComplex) && depth < MAX_DEPTH) {
      var summaryChildren = [
        name ? el("span", { class: "name", text: name }) : null,
        required ? el("span", { class: "req", text: "required" }) : null,
        el("span", { class: "type", text: typeLabel(target) }),
      ];
      if (target.description) summaryChildren.push(el("span", { class: "doc", text: target.description }));
      var details = el("details", {}, [el("summary", {}, summaryChildren)]);
      if (complex) {
        var requiredList = target.required || [];
        Object.keys(target.properties).forEach(function (key) {
          details.appendChild(schemaNode(target.properties[key], depth + 1, key, requiredList.indexOf(key) !== -1));
        });
      } else if (itemsComplex) {
        details.appendChild(schemaNode(target.items, depth + 1, "[]", false));
      } else {
        (target.anyOf || target.oneOf).forEach(function (variant, index) {
          details.appendChild(schemaNode(variant, depth + 1, "variant " + (index + 1), false));
        });
      }
      return details;
    }

    var row = el("div", { class: "prop" }, [
      name ? el("span", { class: "name", text: name }) : null,
      required ? el("span", { class: "req", text: "required" }) : null,
      el("span", { class: "type", text: typeLabel(target) }),
    ]);
    var meta = [];
    if (target.minimum !== undefined) meta.push("min " + target.minimum);
    if (target.maximum !== undefined) meta.push("max " + target.maximum);
    if (target.minLength !== undefined) meta.push("min length " + target.minLength);
    if (target.maxLength !== undefined) meta.push("max length " + target.maxLength);
    if (target.default !== undefined) meta.push("default " + JSON.stringify(target.default));
    if (meta.length) row.appendChild(el("span", { class: "meta", text: meta.join(", ") }));
    if (target.description) row.appendChild(el("span", { class: "doc", text: target.description }));
    return row;
  }

  function schemaTree(schema) {
    if (!schema) return el("p", { class: "empty", text: "No body." });
    var open = el("details", { open: "" }, [el("summary", {}, [el("span", { class: "type", text: typeLabel(schema) })])]);
    if (schema.$ref) {
      var resolved = resolve(schema.$ref);
      open.appendChild(schemaNode(resolved, 1, "", false));
    } else if (isObjectSchema(schema) && schema.properties) {
      var required = schema.required || [];
      Object.keys(schema.properties).forEach(function (key) {
        open.appendChild(schemaNode(schema.properties[key], 1, key, required.indexOf(key) !== -1));
      });
    } else {
      open.appendChild(schemaNode(schema, 1, "", false));
    }
    return el("div", { class: "schema" }, [open]);
  }

  // ───────────────────────────── curl examples ─────────────────────────────
  function shellQuote(value) {
    return "'" + String(value).replace(/'/g, "'\\''") + "'";
  }

  function exampleValue(schema, depth) {
    if (!schema || depth > 4) return null;
    if (schema.example !== undefined) return schema.example;
    if (schema.$ref) return exampleValue(resolve(schema.$ref), depth + 1);
    if (schema.const !== undefined) return schema.const;
    if (schema.enum && schema.enum.length) return schema.enum[0];
    if (schema.anyOf) return exampleValue(schema.anyOf[0], depth + 1);
    switch (schema.type) {
      case "object": {
        if (schema.additionalProperties === true) return {};
        var out = {};
        var required = schema.required || [];
        Object.keys(schema.properties || {}).forEach(function (key) {
          if (required.indexOf(key) === -1 && Object.keys(out).length >= 3) return;
          var value = exampleValue(schema.properties[key], depth + 1);
          if (value !== null && (required.indexOf(key) !== -1 || Object.keys(out).length < 2)) out[key] = value;
        });
        return out;
      }
      case "array":
        return schema.items ? [exampleValue(schema.items, depth + 1)] : [];
      case "integer":
      case "number":
        return schema.default !== undefined ? schema.default : 0;
      case "boolean":
        return schema.default !== undefined ? schema.default : false;
      case "string": {
        if (schema.default !== undefined) return schema.default;
        if (schema.format === "email") return "user@example.com";
        if (schema.format === "uri") return "https://example.com/webhook";
        return schema.pattern ? "" : "string";
      }
      default:
        return null;
    }
  }

  function curlFor(operation, path, method) {
    var url = state.baseUrl + path.replace(/\{([^}]+)\}/g, function (_, name) {
      return "<" + name + ">";
    });
    var security = operation.security || [];
    var scheme = security.length && security[0] ? Object.keys(security[0])[0] : null;
    var lines = ["curl -X " + method.toUpperCase() + " " + shellQuote(url)];
    if (scheme === "SecretKey" || scheme === "MachineSecret") {
      lines.push("  -H " + shellQuote("Authorization: Bearer " + (scheme === "SecretKey" ? "sk_live_..." : "mk_...")));
    } else if (scheme === "SessionToken") {
      lines.push("  -H " + shellQuote("Authorization: Bearer <session jwt>"));
    } else if (scheme === "OAuth2") {
      lines.push("  -H " + shellQuote("Authorization: Bearer <access token>"));
    } else if (scheme === "ClientCookie") {
      lines.push("  --cookie " + shellQuote("__client=<client token>"));
    }
    var body = operation.requestBody;
    if (body && body.content) {
      var contentType = Object.keys(body.content)[0];
      var schema = body.content[contentType].schema;
      if (contentType.indexOf("json") !== -1) {
        var example = exampleValue(schema, 0);
        lines.push("  -H " + shellQuote("Content-Type: application/json"));
        lines.push("  -d " + shellQuote(JSON.stringify(example === null ? {} : example, null, 2).replace(/\n/g, "\n     ")));
      } else {
        lines.push("  -H " + shellQuote("Content-Type: " + contentType));
        lines.push("  -d " + shellQuote("field=value"));
      }
    }
    return lines.join(" \\\n");
  }

  function copyButton(text) {
    var button = el("button", { class: "copy", type: "button", text: "Copy" });
    button.addEventListener("click", function () {
      function done() {
        button.textContent = "Copied";
        button.setAttribute("data-done", "true");
        window.setTimeout(function () {
          button.textContent = "Copy";
          button.removeAttribute("data-done");
        }, 1400);
      }
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () { fallback(text, done); });
      } else {
        fallback(text, done);
      }
    });
    return button;
  }

  function fallback(text, done) {
    var area = el("textarea", { style: "position:fixed;top:-1000px;left:-1000px" });
    area.value = text;
    document.body.appendChild(area);
    area.select();
    try { document.execCommand("copy"); } catch (_) { /* clipboard blocked */ }
    document.body.removeChild(area);
    done();
  }

  // ───────────────────────────── operation rendering ─────────────────────────────
  var SECURITY_LABELS = {
    none: "public",
    backend: "secret key",
    frontend: "client cookie",
    frontendOptional: "client cookie (optional)",
    oauth: "OAuth token",
    machineSecret: "machine secret",
  };

  function securityChips(operation) {
    var security = operation.security;
    if (!security || security.length === 0) {
      return el("div", { class: "security-list" }, [el("span", { class: "chip", "data-kind": "none" }, [el("span", { class: "dot" }), "public"])]);
    }
    var chips = [];
    security.forEach(function (requirement) {
      var names = Object.keys(requirement);
      if (!names.length) {
        chips.push(el("span", { class: "chip", "data-kind": "none" }, [el("span", { class: "dot" }), "public"]));
        return;
      }
      names.forEach(function (name) {
        var scheme = state.spec.components.securitySchemes[name] || {};
        var kind = name === "SecretKey" || name === "MachineSecret" ? "backend" : "other";
        chips.push(el("span", { class: "chip", "data-kind": kind }, [el("span", { class: "dot" }), name + " — " + (scheme.description ? scheme.description.split(".")[0] : "")]));
      });
    });
    return el("div", { class: "security-list" }, chips);
  }

  function parameterTable(parameters) {
    var head = el("tr", {}, [el("th", { text: "Name" }), el("th", { text: "In" }), el("th", { text: "Type" }), el("th", { text: "Description" })]);
    var rows = parameters.map(function (entry) {
      // Pagination parameters are shared, so they arrive as `$ref`s.
      var parameter = entry.$ref ? (resolve(entry.$ref) || entry) : entry;
      var schema = parameter.schema || {};
      var type = typeLabel(schema);
      if (schema.enum) type = schema.enum.join(" | ");
      return el("tr", {}, [
        el("td", {}, [
          el("code", { text: parameter.name }),
          parameter.required ? el("span", { class: "required", text: " required" }) : null,
        ]),
        el("td", {}, [el("span", { class: "param-in", text: parameter.in })]),
        el("td", {}, [el("span", { class: "type", text: type })]),
        el("td", {}, [
          parameter.description ? el("span", { text: parameter.description }) : null,
          schema.default !== undefined ? el("span", { class: "meta", text: " Default: " + JSON.stringify(schema.default) + "." }) : null,
        ]),
      ]);
    });
    return el("table", { class: "params" }, [el("thead", {}, [head]), el("tbody", {}, rows)]);
  }

  var STATUS_TEXT = {
    200: "Success",
    201: "Created",
    204: "No content",
    400: "Bad request",
    401: "Unauthenticated",
    403: "Forbidden",
    404: "Not found",
    409: "Conflict",
    422: "Validation failed",
    429: "Rate limited",
  };

  function responseList(operation) {
    var responses = operation.responses || {};
    var codes = Object.keys(responses).sort(function (a, b) { return Number(a) - Number(b); });
    return el("div", { class: "responses" }, codes.map(function (code) {
      var response = responses[code];
      var content = response.content || {};
      var contentType = Object.keys(content)[0];
      var schema = contentType ? content[contentType].schema : null;
      var summary = el("summary", {}, [
        el("span", { class: "status", "data-class": code.charAt(0), text: code }),
        el("span", { class: "resp-desc", text: STATUS_TEXT[code] || response.description || "" }),
        schema ? el("span", { class: "type", text: typeLabel(schema) }) : null,
      ]);
      var details = el("details", { class: "resp" }, [summary]);
      if (schema) {
        details.appendChild(el("div", { class: "resp-body" }, [schemaTree(schema)]));
      } else if (response.description) {
        details.appendChild(el("div", { class: "resp-body" }, [el("p", { class: "empty", text: response.description })]));
      }
      return details;
    }));
  }

  function renderOperation(path, method, operation, tagName) {
    var id = method + "-" + slug(path + "-" + operation.operationId);
    var head = el("button", {
      class: "op-head",
      type: "button",
      "aria-expanded": "false",
      "aria-controls": id + "-body",
    }, [
      el("span", { class: "method", "data-method": method, text: method.toUpperCase() }),
      el("span", { class: "op-path", text: path }),
      el("span", { class: "op-summary", text: operation.summary || "" }),
      el("span", { class: "op-chevron", "aria-hidden": "true", text: "›" }),
    ]);

    var body = el("div", { class: "op-body", id: id + "-body", hidden: "" });

    if (operation.description) body.appendChild(el("p", { class: "op-desc", text: operation.description }));
    body.appendChild(el("div", { class: "block" }, [el("h3", { text: "Credentials" }), securityChips(operation)]));

    if (operation.parameters && operation.parameters.length) {
      body.appendChild(el("div", { class: "block" }, [el("h3", { text: "Parameters" }), parameterTable(operation.parameters)]));
    }

    if (operation.requestBody && operation.requestBody.content) {
      var contentType = Object.keys(operation.requestBody.content)[0];
      var bodySchema = operation.requestBody.content[contentType].schema;
      body.appendChild(el("div", { class: "block" }, [
        el("h3", { text: "Request body — " + contentType }),
        schemaTree(bodySchema),
      ]));
    }

    body.appendChild(el("div", { class: "block" }, [el("h3", { text: "Responses" }), responseList(operation)]));

    var curl = curlFor(operation, path, method);
    body.appendChild(el("div", { class: "block" }, [
      el("h3", { text: "Example" }),
      el("div", { class: "curl-wrap" }, [el("pre", {}, [el("code", { text: curl })]), copyButton(curl)]),
    ]));

    body.appendChild(el("div", { class: "block" }, [
      el("p", { class: "meta" }, [
        el("span", { class: "mono", text: operation.operationId }),
        tagName ? " · " + tagName : "",
      ]),
    ]));

    head.addEventListener("click", function () {
      var open = head.getAttribute("aria-expanded") === "true";
      head.setAttribute("aria-expanded", open ? "false" : "true");
      if (open) body.setAttribute("hidden", "");
      else body.removeAttribute("hidden");
    });

    return el("div", { class: "op", id: id, "data-search": (method + " " + path + " " + (operation.summary || "") + " " + (operation.description || "") + " " + operation.operationId + " " + tagName).toLowerCase() }, [head, body]);
  }

  // ───────────────────────────── page ─────────────────────────────
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

  function fail(message) {
    var root = document.getElementById("sections");
    clear(root);
    root.appendChild(el("p", { class: "notice", text: message }));
  }

  function start(spec) {
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

  fetch("/v1/openapi.json", { credentials: "same-origin" })
    .then(function (response) {
      if (!response.ok) throw new Error("HTTP " + response.status);
      return response.json();
    })
    .then(start)
    .catch(function (error) {
      fail("Could not load /v1/openapi.json (" + error.message + ").");
    });
})();
