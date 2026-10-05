import { createRoot } from "react-dom/client";
import App from "./App";
import { getRT } from "./runtime";
import { useStore } from "./store";
import "./styles.css";

// debug handles (handy for poking the scene from the console)
Object.assign(window, { __store: useStore, __getRT: getRT });

createRoot(document.getElementById("root")!).render(<App />);
