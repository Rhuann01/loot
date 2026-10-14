import axios from "axios";

export const api = axios.create({
  baseURL: import.meta.env.VITE_API_URL || "http://localhost:3000",
  auth: {
    username: import.meta.env.VITE_PAINEL_USER || "admin",
    password: import.meta.env.VITE_PAINEL_SENHA || "admin",
  },
});