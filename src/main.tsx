import { createRoot } from "react-dom/client";
import { Customer } from "./customer";
import { Staff } from "./staff";
import "./style.css";
const path = window.location.pathname;
createRoot(document.getElementById("root")!).render(
  ["/staff", "/kitchen", "/admin"].includes(path) ? (
    <Staff
      role={
        path === "/staff"
          ? "register"
          : path === "/kitchen"
            ? "kitchen"
            : "admin"
      }
    />
  ) : (
    <Customer />
  ),
);
