import { render } from "preact";
import { useEffect, useState } from "preact/hooks";
import "./styles.css";
import { Toaster } from "./ui";
import { Home } from "./pages/Home";
import { Cashier } from "./pages/Cashier";
import { Admin } from "./pages/Admin";

function route(): string {
  return location.hash.replace(/^#/, "") || "/";
}

function App() {
  const [path, setPath] = useState(route());
  useEffect(() => {
    const on = () => setPath(route());
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);

  return (
    <>
      {path.startsWith("/admin") ? <Admin /> : path.startsWith("/kasse") ? <Cashier /> : <Home />}
      <Toaster />
    </>
  );
}

render(<App />, document.getElementById("app")!);
