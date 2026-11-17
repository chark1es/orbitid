/*
 * Schema rendering: type labels and collapsible schema trees.
 *
 * `$ref`s are resolved against the loaded spec and rendered as links that jump to the referenced schema summary.
 */
import { el, scrollTo, slug } from "./dom.js";
import { state } from "./state.js";

export function resolve(ref) {
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

var MAX_DEPTH = 6;

export function typeLabel(schema) {
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

export function isObjectSchema(schema) {
  return schema && typeof schema === "object" && (schema.type === "object" || schema.properties);
}

export function schemaNode(schema, depth, name, required) {
  if (!schema || typeof schema !== "object") return el("span", { class: "empty", text: "any" });

  var target = schema;
  if (schema.$ref) {
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
    required ? el("span", { class: "req", text: "required", title: "required" }) : null,
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

export function schemaTree(schema) {
  if (!schema) return el("p", { class: "empty", text: "No body." });
  var attrs = { open: "" };
  if (schema.$ref) {
    var id = "schema-" + slug(schema.$ref.split("/").pop());
    // The first rendered occurrence owns the id; every `$ref` link jumps to it. Re-renders clear the sections
    // first, so the lookup never finds a stale node from the previous pass.
    if (!document.getElementById(id)) attrs.id = id;
  }
  var open = el("details", attrs, [el("summary", {}, [el("span", { class: "type", text: typeLabel(schema) })])]);
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
