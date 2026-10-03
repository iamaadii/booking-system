CREATE DATABASE IF NOT EXISTS booking_db;
USE booking_db;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  name VARCHAR(100) NOT NULL,
  email VARCHAR(150) NOT NULL UNIQUE,
  password_hash VARCHAR(255) NOT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE shows (
  id INT AUTO_INCREMENT PRIMARY KEY,
  title VARCHAR(150) NOT NULL,
  show_time DATETIME NOT NULL
);

CREATE TABLE seats (
  id INT AUTO_INCREMENT PRIMARY KEY,
  show_id INT NOT NULL,
  seat_number VARCHAR(10) NOT NULL,
  status ENUM('available', 'held', 'booked') NOT NULL DEFAULT 'available',
  held_by INT NULL,
  hold_expires_at DATETIME NULL,
  UNIQUE (show_id, seat_number),
  FOREIGN KEY (show_id) REFERENCES shows(id),
  FOREIGN KEY (held_by) REFERENCES users(id)
);

CREATE TABLE bookings (
  id INT AUTO_INCREMENT PRIMARY KEY,
  user_id INT NOT NULL,
  seat_id INT NOT NULL,
  status ENUM('confirmed', 'cancelled') NOT NULL DEFAULT 'confirmed',
  active_seat_id INT NULL,
  created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (active_seat_id),
  FOREIGN KEY (user_id) REFERENCES users(id),
  FOREIGN KEY (seat_id) REFERENCES seats(id)
);