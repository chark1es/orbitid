import * as React from "react";
import { Checkbox, Input, SelectTrigger, Switch, Textarea } from "@orbitid/ui";

const controls = new Set<unknown>(["input", "select", "textarea", Input, Textarea, SelectTrigger, Checkbox, Switch]);

function isControl(child: React.ReactElement<Record<string, unknown>>) {
  return controls.has(child.type) && child.props.type !== "hidden";
}

export function firstControlId(children: React.ReactNode): string | undefined {
  for (const node of React.Children.toArray(children)) {
    if (!React.isValidElement<Record<string, unknown>>(node)) continue;
    if (isControl(node) && typeof node.props.id === "string") return node.props.id;
    const nested = firstControlId(node.props.children as React.ReactNode);
    if (nested) return nested;
  }
}

/** Reach triggers inside layout/Select wrappers while leaving labels, items and unrelated controls alone. */
export function associateFieldControl(children: React.ReactNode, field: {
  id: string;
  describedBy?: string;
  invalid: boolean;
  required?: boolean;
}): React.ReactNode {
  let associated = false;
  function visit(nodes: React.ReactNode): React.ReactNode {
    return React.Children.map(nodes, (node) => {
      if (!React.isValidElement<Record<string, unknown>>(node)) return node;
      const props = node.props;
      if (!associated && (props.id === field.id || (isControl(node) && !props.id))) {
        associated = true;
        const descriptions = [...new Set(`${props["aria-describedby"] ?? ""} ${field.describedBy ?? ""}`.split(/\s+/).filter(Boolean))].join(" ");
        return React.cloneElement(node, {
          id: field.id,
          "aria-describedby": descriptions || undefined,
          "aria-invalid": field.invalid || props["aria-invalid"] || undefined,
          "aria-required": field.required || props["aria-required"] || undefined,
        });
      }
      return props.children ? React.cloneElement(node, { children: visit(props.children as React.ReactNode) }) : node;
    });
  }
  return visit(children);
}
