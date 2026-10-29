/** Clipboard, download and print helpers shared by the profile and sign-in screens. */

export async function copyText(text: string): Promise<void> {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
  }
}

export function downloadText(filename: string, text: string): void {
  if (typeof document === "undefined" || typeof URL.createObjectURL !== "function") return;
  const blob = new Blob([text], { type: "text/plain" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}

export function printText(text: string): void {
  if (typeof window === "undefined") return;
  const win = window.open("", "_blank", "noopener,noreferrer");
  if (!win) return;
  win.document.write(`<pre>${text.replace(/</g, "&lt;")}</pre>`);
  win.document.close();
  win.print();
}
