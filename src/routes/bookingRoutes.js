import express from "express";
import pool from "../db.js";
import { requireLogin } from "../middleware/requireLogin.js";
import { cancelBooking } from "../services/bookingService.js";

const router = express.Router();

router.get("/me", requireLogin, async (req, res) => {
    try {
        const result = await pool.query(
            "SELECT b.id AS booking_id, b.status, b.created_at, " +
            "s.seat_number, sh.title, sh.show_time " +
            "FROM bookings b " +
            "JOIN seats s ON s.id = b.seat_id " +
            "JOIN shows sh ON sh.id = s.show_id " +
            "WHERE b.user_id = ? " +
            "ORDER BY b.created_at DESC, b.id DESC",
            [req.userId]
        );

        return res.json({ bookings: result[0] });
    } catch (err) {
        console.log("My bookings error:", err.message);
        return res.status(500).json({ message: "Something went wrong" });
    }
});

router.delete("/:id", requireLogin, async (req, res) => {
    try {
        const bookingId = Number(req.params.id);

        if (!Number.isInteger(bookingId)) {
            return res.status(400).json({ message: "Booking id must be a number" });
        }

        const result = await cancelBooking(req.userId, bookingId);

        if (result.ok === false) {
            return res.status(result.status).json({ message: result.message });
        }

        return res.json({ message: result.message });
    } catch (err) {
        console.log("Cancel booking error:", err.message);
        return res.status(500).json({ message: "Something went wrong" });
    }
});

export default router;