/*
 * Example generation: builds a copyable curl command from an operation, including a representative JSON body.
 */
import { el } from "./dom.js";
import { resolve } from "./schema.js";
import { state } from "./state.js";

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

export function curlFor(operation, path, method) {
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

export function copyButton(text) {
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
  var area = el("textarea", { class: "copy-fallback" });
  area.value = text;
  document.body.appendChild(area);
  area.select();
  try { document.execCommand("copy"); } catch (_) { /* clipboard blocked */ }
  document.body.removeChild(area);
  done();
}
