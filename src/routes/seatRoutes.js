import express from "express";
import pool from "../db.js";
import { requireLogin } from "../middleware/requireLogin.js";
import { bookSeat, holdSeat } from "../services/bookingService.js";

const router = express.Router();

router.get("/shows/:id/seats", async (req, res) => {
  try {
    const showId = Number(req.params.id);

    if (!Number.isInteger(showId)) {
      return res.status(400).json({ message: "Show id must be a number" });
    }

    const showResult = await pool.query(
      "SELECT id, title, show_time FROM shows WHERE id = ?",
      [showId]
    );
    const showRows = showResult[0];

    if (showRows.length === 0) {
      return res.status(404).json({ message: "Show not found" });
    }

    const seatResult = await pool.query(
      "SELECT id, seat_number, " +
        "CASE WHEN status = 'held' AND hold_expires_at <= NOW() THEN 'available' ELSE status END AS status " +
        "FROM seats WHERE show_id = ? ORDER BY seat_number",
      [showId]
    );
    const seatRows = seatResult[0];

    return res.json({ show: showRows[0], seats: seatRows });
  } catch (err) {
    console.log("List seats error:", err.message);
    return res.status(500).json({ message: "Something went wrong" });
  }
});


router.post("/seats/:id/book", requireLogin, async (req, res) => {
  try {
    const seatId = Number(req.params.id);

    if (!Number.isInteger(seatId)) {
      return res.status(400).json({ message: "Seat id must be a number" });
    }

    const result = await bookSeat(req.userId, seatId);

    if (result.ok === false) {
      return res.status(result.status).json({ message: result.message });
    }

    return res.status(201).json({ message: "Seat booked", bookingId: result.bookingId });
  } catch (err) {
    console.log("Book seat error:", err.message);
    return res.status(500).json({ message: "Something went wrong" });
  }
});

router.post("/seats/:id/hold", requireLogin, async (req, res) => {
  try {
    const seatId = Number(req.params.id);

    if (!Number.isInteger(seatId)) {
      return res.status(400).json({ message: "Seat id must be a number" });
    }

    const result = await holdSeat(req.userId, seatId);

    if (result.ok === false) {
      return res.status(result.status).json({ message: result.message });
    }

    return res.json({ message: result.message });
  } catch (err) {
    console.log("Hold seat error:", err.message);
    return res.status(500).json({ message: "Something went wrong" });
  }
});

export default router;