import { useEffect, useState } from "react";

const API_BASE =
  import.meta.env.VITE_API_BASE_URL ??
  "http://127.0.0.1:8787";

type ApiState =
  | "checking"
  | "online"
  | "offline";

export default function ApiStatus() {
  const [state, setState] =
    useState<ApiState>("checking");

  useEffect(() => {
    let active = true;

    const check = async () => {
      try {
        const response = await fetch(
          `${API_BASE}/health`,
          {
            method: "GET",
            cache: "no-store"
          }
        );

        if (active) {
          setState(
            response.ok
              ? "online"
              : "offline"
          );
        }
      } catch {
        if (active) {
          setState("offline");
        }
      }
    };

    void check();

    const timer = window.setInterval(
      check,
      5000
    );

    return () => {
      active = false;
      window.clearInterval(timer);
    };
  }, []);

  const label =
    state === "online"
      ? "API online"
      : state === "offline"
        ? "API offline"
        : "Checking API…";

  return (
    <div
      className={`api-status api-status-${state}`}
      aria-live="polite"
    >
      <span
        className="api-status-dot"
        aria-hidden="true"
      />
      <span>{label}</span>
    </div>
  );
}
