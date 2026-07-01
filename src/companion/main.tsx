import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import { CompanionApp } from "./CompanionApp";

// Mark this bundle as the phone companion so shared helpers route to the remote
// server instead of Tauri's invoke().
(window as unknown as { __GT_COMPANION__?: boolean }).__GT_COMPANION__ = true;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <CompanionApp />
  </React.StrictMode>
);
