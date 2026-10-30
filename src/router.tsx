import { useEffect, useState } from "preact/hooks";

export interface Route {
  name: "roster" | "wall" | "me" | "mentors" | "edit" | "admin";
  id?: string;
}

function parse(hash: string): Route {
  const clean = hash.replace(/^#/, "");
  if (clean === "" || clean === "/") return { name: "roster" };
  if (clean === "/me/edit") return { name: "edit" };
  if (clean === "/me") return { name: "me" };
  if (clean === "/mentors") return { name: "mentors" };
  if (clean === "/admin") return { name: "admin" };
  const m = clean.match(/^\/m\/([^/?]+)/);
  if (m) return { name: "wall", id: decodeURIComponent(m[1]) };
  return { name: "roster" };
}

export function useHashRoute(): Route {
  const [route, setRoute] = useState<Route>(() => parse(location.hash));
  useEffect(() => {
    const onChange = () => setRoute(parse(location.hash));
    window.addEventListener("hashchange", onChange);
    return () => window.removeEventListener("hashchange", onChange);
  }, []);
  return route;
}

export function navigate(to: string): void {
  if (location.hash === `#${to}`) {
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  } else {
    location.hash = to;
  }
}
