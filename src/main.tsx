import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { HashRouter } from "react-router-dom";
import App from "./App";
import { applyPrefsToDom, hydratePrefs, useApp } from "./store/app";
import "./index.css";

// Reflect persisted appearance prefs before first paint (accent, motion, density).
applyPrefsToDom(useApp.getState().prefs);
// Restore prefs from the DB backup if local storage was wiped (reinstall).
void hydratePrefs();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false, staleTime: 10_000 },
  },
});

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <QueryClientProvider client={queryClient}>
      <HashRouter>
        <App />
      </HashRouter>
    </QueryClientProvider>
  </React.StrictMode>
);
