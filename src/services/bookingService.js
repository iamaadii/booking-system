import pool from "../db.js";

const HOLD_MINUTES = 5;

const SEAT_QUERY =
  "SELECT id, status, held_by, " +
  "(hold_expires_at IS NOT NULL AND hold_expires_at <= NOW()) AS hold_expired " +
  "FROM seats WHERE id = ? FOR UPDATE";

export async function holdSeat(userId, seatId) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const seatResult = await connection.query(SEAT_QUERY, [seatId]);
    const seatRows = seatResult[0];

    if (seatRows.length === 0) {
      await connection.rollback();
      return { ok: false, status: 404, message: "Seat not found" };
    }

    const seat = seatRows[0];
    const holdExpired = Number(seat.hold_expired) === 1;
    const isHeld = seat.status === "held" && !holdExpired;

    if (seat.status === "booked") {
      await connection.rollback();
      return { ok: false, status: 409, message: "Seat is already booked" };
    }

    if (isHeld && seat.held_by !== userId) {
      await connection.rollback();
      return { ok: false, status: 409, message: "Seat is held by someone else" };
    }

    if (isHeld && seat.held_by === userId) {
      await connection.rollback();
      return { ok: true, message: "You already hold this seat" };
    }

    await connection.query(
      "UPDATE seats SET status = 'held', held_by = ?, hold_expires_at = NOW() + INTERVAL ? MINUTE WHERE id = ?",
      [userId, HOLD_MINUTES, seatId]
    );

    await connection.commit();

    return { ok: true, message: "Seat held for " + HOLD_MINUTES + " minutes" };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}

export async function bookSeat(userId, seatId) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const seatResult = await connection.query(SEAT_QUERY, [seatId]);
    const seatRows = seatResult[0];

    if (seatRows.length === 0) {
      await connection.rollback();
      return { ok: false, status: 404, message: "Seat not found" };
    }

    const seat = seatRows[0];
    const holdExpired = Number(seat.hold_expired) === 1;
    const isHeld = seat.status === "held" && !holdExpired;

    if (seat.status === "booked") {
      await connection.rollback();
      return { ok: false, status: 409, message: "Seat is already booked" };
    }

    if (isHeld && seat.held_by !== userId) {
      await connection.rollback();
      return { ok: false, status: 409, message: "Seat is held by someone else" };
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
      return { ok: false, status: 409, message: "Seat is already booked" };
    }

    throw err;
  } finally {
    connection.release();
  }
}

export async function cancelBooking(userId, bookingId) {
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();

    const bookingResult = await connection.query(
      "SELECT id, user_id, seat_id, status FROM bookings WHERE id = ? FOR UPDATE",
      [bookingId]
    );
    const bookingRows = bookingResult[0];

    if (bookingRows.length === 0) {
      await connection.rollback();
      return { ok: false, status: 404, message: "Booking not found" };
    }

    const booking = bookingRows[0];

    if (booking.user_id !== userId) {
      await connection.rollback();
      return { ok: false, status: 404, message: "Booking not found" };
    }

    if (booking.status === "cancelled") {
      await connection.rollback();
      return { ok: false, status: 409, message: "Booking is already cancelled" };
    }

    await connection.query(
      "UPDATE bookings SET status = 'cancelled', active_seat_id = NULL WHERE id = ?",
      [bookingId]
    );

    await connection.query(
      "UPDATE seats SET status = 'available', held_by = NULL, hold_expires_at = NULL WHERE id = ?",
      [booking.seat_id]
    );

    await connection.commit();

    return { ok: true, message: "Booking cancelled" };
  } catch (err) {
    await connection.rollback();
    throw err;
  } finally {
    connection.release();
  }
}