import axios from "axios";

export const eventoAuth = new EventTarget();

const fallbackUrl = import.meta.env.DEV ? "http://localhost:3001" : "";
export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || fallbackUrl,
  withCredentials: true,
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (
      error.response?.status === 401 &&
      !error.config?.url?.includes("/api/auth/login") &&
      !error.config?.url?.includes("/api/auth/me")
    ) {
      eventoAuth.dispatchEvent(new Event("desautenticado"));
    }
    return Promise.reject(error);
  },
);