import pool from "../db.js";

export async function bookSeat(userId, seatId) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const seatResult = await connection.query(
      "SELECT id, status FROM seats WHERE id = ? FOR UPDATE",
      [seatId]
    );
    const seatRows = seatResult[0];

    if (seatRows.length === 0) {
      await connection.rollback();
      return { ok: false, status: 404, message: "Seat not found" };
    }

    const seat = seatRows[0];

    if (seat.status !== "available") {
      await connection.rollback();
      return { ok: false, status: 409, message: "Seat is not available" };
    }

    await connection.query(
      "UPDATE seats SET status = 'booked', held_by = NULL, hold_expires_at = NULL WHERE id = ?",
      [seatId]
    );

    const insertResult = await connection.query(
      "INSERT INTO bookings (user_id, seat_id, active_seat_id) VALUES (?, ?, ?)",
      [userId, seatId, seatId]
    );

    await connection.commit();

    return { ok: true, bookingId: insertResult[0].insertId };
  } catch (err) {
    await connection.rollback();

    if (err.code === "ER_DUP_ENTRY") {
      return { ok: false, status: 409, message: "Seat is not available" };
    }

    throw err;
  } finally {
    connection.release();
  }
}