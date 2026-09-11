/* global window */

const { ipcRenderer } = require("electron");

const LINK_CHANNEL = "gofer:browser-link-clicked";
const NAVIGATION_CHANNEL = "gofer:browser-navigation";
const ZOOM_CHANNEL = "gofer:browser-zoom";

window.addEventListener("wheel", (event) => {
  if (
    event.defaultPrevented
    || (!event.ctrlKey && !event.metaKey)
    || event.altKey
    || event.deltaY === 0
  ) return;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.send(ZOOM_CHANNEL, {
    direction: event.deltaY < 0 ? 1 : -1,
  });
}, { capture: true, passive: false });

window.addEventListener("click", (event) => {
  if (
    event.defaultPrevented
    || event.button !== 0
  ) return;
  const anchor = event.composedPath().find((node) => node?.tagName === "A");
  if (!anchor || anchor.hasAttribute("download")) return;
  const rawHref = String(anchor.getAttribute?.("href") || "").trim();
  const localPreview = /^file:/i.test(window.location.href);
  const url = localPreview && rawHref.startsWith("//")
    ? `https:${rawHref}`
    : String(anchor.href || "").trim();
  if (!/^(?:https?|file):/i.test(url)) return;
  const modified = event.ctrlKey || event.metaKey;
  const localFile = /^file:/i.test(url);
  // Keep same-document anchors in the preview, including full file URLs.
  const sameDocument = url.split("#", 1)[0] === window.location.href.split("#", 1)[0];
  const websiteFromPreview = localPreview && /^https?:/i.test(url);
  if (!modified && !websiteFromPreview && (!localFile || sameDocument)) return;
  event.preventDefault();
  event.stopPropagation();
  ipcRenderer.send(LINK_CHANNEL, { url });
}, true);

window.addEventListener("keydown", (event) => {
  if (
    event.defaultPrevented
    || event.repeat
    || event.key !== "Backspace"
    || event.altKey
    || event.ctrlKey
    || event.metaKey
    || event.shiftKey
    || event.composedPath().some(isEditableNode)
  ) return;
  event.preventDefault();
  ipcRenderer.send(NAVIGATION_CHANNEL, { action: "back" });
}, true);

function isEditableNode(node) {
  return Boolean(
    node?.isContentEditable
    || ["INPUT", "SELECT", "TEXTAREA"].includes(node?.tagName),
  );
}
