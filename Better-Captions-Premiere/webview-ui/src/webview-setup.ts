import * as Comlink from "comlink";

import type { API } from "../../src/api/api";
import { updateColorScheme } from "./webview-api";
import { cepApi, isCEP, watchActiveSequence } from "./cep/api";
import { loadCustomFonts } from "./cep/fonts";

interface UXPWebviewWindow extends Window {
  uxpHost: {
    postMessage: (msg: any) => void;
    addEventListener: (type: string, handler: Function) => void;
    removeEventListener: (type: string, handler: Function) => void;
  };
}
declare var window: UXPWebviewWindow;

const hostEndpoint = {
  postMessage: (msg: any) => window.uxpHost.postMessage(msg),
  addEventListener: (type: string, handler: Function) => {
    window.uxpHost.addEventListener("message", handler);
  },
  removeEventListener: (type: string, handler: Function) => {
    window.uxpHost.removeEventListener("message", handler);
  },
};

export const initWebview = (webviewAPI: typeof import("./webview-api")): { page: string; api: API } => {
  if (isCEP()) {
    // Running as a CEP extension: no UXP host to talk to, use the CEP API directly.
    cepApi.getColorScheme().then((scheme) => updateColorScheme(scheme as any));
    watchActiveSequence(webviewAPI.onSequenceActivated, webviewAPI.onSequenceClosed);
    // Fonts added in the panel are loaded once; the preview redraws when they're ready.
    loadCustomFonts()
      .then(() => window.dispatchEvent(new Event("bc-fonts-ready")))
      .catch((e) => console.warn("Loading added fonts failed:", e));
    // Premiere keeps Ctrl+V / Cmd+V for itself unless the panel asks for it.
    try {
      (window as any).__adobe_cep__.registerKeyEventsInterest(
        JSON.stringify([
          { keyCode: 86, ctrlKey: true }, // Windows: Ctrl+V
          { keyCode: 9, metaKey: true }, // macOS: Cmd+V
        ]),
      );
    } catch {}
    // A file dropped outside the drop zone would otherwise replace the panel with that file.
    window.addEventListener("dragover", (e) => e.preventDefault());
    window.addEventListener("drop", (e) => e.preventDefault());
    return { api: cepApi as unknown as API, page: "main" };
  }

  const page =
    new URL(location.href).searchParams.get("page") ||
    location.href.split("/").pop()!.replace(".html", "");
  console.log("initWebview called", webviewAPI);
  const endpoint = Comlink.windowEndpoint(hostEndpoint);
  // const endpoint = Comlink.windowEndpoint(hostEndpoint, window);
  const comlinkAPI = Comlink.wrap(endpoint);
  Comlink.expose(webviewAPI, endpoint);
  //@ts-ignore
  const api = comlinkAPI.api as API;
  // update color scheme on load
  api.getColorScheme().then((scheme) => {
    updateColorScheme(scheme);
  });
  return { api, page };
};

// basic way to send a message
// const sendMessage = () => window.uxpHost.postMessage({ type: "message", text: "msg" },"*");

// basic way to get a message
// window.addEventListener("message", (e) => console.log(e));
