# Golf Labs Kiosk Application

## Overview

This is a lightweight Electron-based desktop application designed to run in "kiosk mode" on the PCs connected to each golf simulator bay. Its core purpose is to enforce the booking schedule by locking the computer when there is no active session and automatically unlocking it for a customer when their paid booking begins.

This ensures that the simulators are only usable during valid, paid booking windows, synchronizing directly with the central booking API.

---

## Features

*   **Automated Locking/Unlocking**: The screen is covered by a "Locked" overlay by default and automatically hides to allow computer access only during an active booking.
*   **Real-time Polling**: When locked, the application polls the backend API every 60 seconds to fetch the latest booking schedule.
*   **Offline Resilience**: If the internet connection drops during an active session, the kiosk remains unlocked until the scheduled end time. It will resume polling once the connection is restored.
*   **Bay-Specific Configuration**: Each kiosk is tied to a specific `bayId` and `locationId` via a simple configuration file.
*   **Manual Sync**: Includes a "Refresh" button on the locked screen for staff to manually trigger a sync with the backend.

---

## Prerequisites

Before running this application, ensure you have:

1.  [Node.js](https://nodejs.org/) installed (which includes `npm`).
2.  The Golf Labs backend API (`GolfLabs.us-api`) running and accessible from the kiosk machine.

---

## Setup & Installation

1.  **Install Dependencies**: Navigate to the `GolfLabsKiosk` directory in your terminal and run the following command to install all required packages:

    ```bash
    npm install
    ```

2.  **Configure the Kiosk**: Open the `config.json` file in the root of the project. You must edit the placeholder values to match your environment:

    ```json
    {
        "bayId": "your-unique-bay-id",
        "locationId": "your-location-id",
        "apiBaseUrl": "http://localhost:4242",
        "timezone": "America/New_York"
    }
    ```

    *   `bayId`: The unique identifier (UUID) for the specific simulator bay this kiosk will be running on.
    *   `locationId`: The unique identifier (UUID) for the facility location.
    *   `apiBaseUrl`: The full URL to your running backend API.
    *   `timezone`: The IANA timezone name for the facility's location (e.g., "America/Los_Angeles", "America/Chicago"). This is critical for ensuring the kiosk operates on the correct local time.

---

## Running the Application

Once configured, you can run the application in one of two modes:

*   **Development Mode**: This will launch the app in a standard, resizable window with developer tools automatically opened. This is ideal for testing and debugging.

    ```bash
    npm run dev
    ```

*   **Production Mode**: This simulates how the app will run for a customer. It launches in a frameless, transparent, fullscreen mode.

    ```bash
    npm start
    ```

To close the application, you can use `Ctrl + C` in the terminal where it is running. 