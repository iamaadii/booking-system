import express from "express";
import authRoutes from "./routes/authRoutes.js";

export const app = express();
app.use(express.json());

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.use("/auth", authRoutes);