import { createRoot } from "react-dom/client";
import { Api } from "../src/api.js";
import { Product } from "../src/product.js";
import "../src/styles.css";

createRoot(document.getElementById("root")!).render(
  <Product
    api={new Api(async () => "controlled-browser-fixture")}
    email="founder@example.test"
    signOut={() => {
      document.body.textContent = "Signed out";
    }}
  />,
);
