import React from "react";
import ReactDOM from "react-dom/client";
import "../index.css";
import { QuestApp } from "./QuestApp";

// Mark this bundle as a companion-style client so shared helpers route to the
// remote link (WebRTC data channel) instead of Tauri's invoke().
(window as unknown as { __GT_COMPANION__?: boolean }).__GT_COMPANION__ = true;

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QuestApp />
  </React.StrictMode>,
);
