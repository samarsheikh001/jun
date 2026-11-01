import { createRoot } from "react-dom/client";
import "../../../../web/styles.css";
import "../../../../web/widget/widget.css";
import "./island.css";
import { IslandApp } from "./IslandApp.tsx";

createRoot(document.getElementById("root")!).render(<IslandApp />);
