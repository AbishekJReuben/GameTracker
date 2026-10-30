import "@fontsource-variable/inter/wght.css";
import "@fontsource-variable/sora/wght.css";
import "@fontsource-variable/jetbrains-mono/wght.css";
import "@/index.css";
import "./notes.css";
import { createRoot } from "react-dom/client";
import { NotesApp } from "./NotesApp";

createRoot(document.getElementById("root")!).render(<NotesApp />);
