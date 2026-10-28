import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
// Inter, self-hosted (bundled by Vite): no requests to a font CDN.
import "@fontsource-variable/inter";
import "./styles.css";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
