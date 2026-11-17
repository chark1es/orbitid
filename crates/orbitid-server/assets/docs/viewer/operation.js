/*
 * Operation rendering: one collapsible card with credentials, parameters, request body, responses and an example.
 */
import { el, slug } from "./dom.js";
import { curlFor, copyButton } from "./curl.js";
import { resolve, schemaTree, typeLabel } from "./schema.js";
import { state } from "./state.js";

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

export function renderOperation(path, method, operation, tagName) {
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
