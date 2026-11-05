/** Auth state context — 3 states: setup incomplete / logged out / logged in (T3.1 auth guard) */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from "react";
import { api, ApiError } from "../api/client";
import type { Me } from "../api/types";

type AuthState =
  | { status: "loading" }
  | { status: "setup" }
  | { status: "anon" }
  | { status: "authed"; me: Me };

interface AuthContextValue {
  state: AuthState;
  refresh(): Promise<void>;
  logout(): Promise<void>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<AuthState>({ status: "loading" });

  const refresh = useCallback(async () => {
    try {
      const me = await api<Me>("/api/auth/me");
      setState({ status: "authed", me });
    } catch (e) {
      if (e instanceof ApiError && e.code === "SETUP_REQUIRED") {
        setState({ status: "setup" });
      } else {
        setState({ status: "anon" });
      }
    }
  }, []);

  const logout = useCallback(async () => {
    await api("/api/auth/logout", { method: "POST" });
    setState({ status: "anon" });
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return (
    <AuthContext.Provider value={{ state, refresh, logout }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth called outside AuthProvider");
  return ctx;
}
