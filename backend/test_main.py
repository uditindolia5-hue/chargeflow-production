import os
import tempfile
import unittest
from pathlib import Path

from backend import main
from backend.main import AccountStatusRequest, AdminPasswordRequest, LoginRequest, RecommendationRequest, STATIONS, network_summary, predict_wait, recommend


class ChargeFlowBackendTests(unittest.TestCase):
    def test_wait_prediction_increases_with_occupancy(self):
        low = predict_wait(0, 6, hour=13, day_of_week=2)
        high = predict_wait(6, 6, hour=13, day_of_week=2)
        self.assertGreater(high, low)

    def test_low_battery_excludes_unreachable_stations(self):
        result = recommend(RecommendationRequest(battery_percent=1, preferred_plug="CCS"))
        self.assertIsNone(result["recommendation"])
        self.assertEqual(result["trace"][1]["args"]["candidate_count"], 0)

    def test_normal_battery_returns_trace_and_candidates(self):
        result = recommend(RecommendationRequest(battery_percent=18, preferred_plug="CCS"))
        self.assertIsNotNone(result["recommendation"])
        self.assertGreaterEqual(len(result["trace"]), 4)
        self.assertGreater(len(STATIONS), 1000)

    def test_network_summary_is_dataset_derived(self):
        summary = network_summary(city="New Delhi")
        self.assertGreater(summary["station_count"], 0)
        self.assertGreaterEqual(summary["open_connectors"], 0)
        self.assertGreater(summary["total_connectors"], summary["open_connectors"])
        self.assertGreater(summary["average_price"], 0)

    def test_city_filter_changes_recommendation_context(self):
        result = recommend(RecommendationRequest(battery_percent=80, preferred_plug="CCS", city="Gurugram", driver_lat=28.4595, driver_lon=77.0266))
        self.assertIsNotNone(result["recommendation"])
        self.assertIn("Gurugram", result["recommendation"]["city"])

    @unittest.skipUnless(os.getenv("CHARGEFLOW_ADMIN_EMAIL") and os.getenv("CHARGEFLOW_ADMIN_PASSWORD"), "requires configured admin secrets")
    def test_admin_control_room_reports_and_controls_users(self):
        original_db_path = main.AUTH_DB_PATH
        original_sessions = main.SESSIONS.copy()
        original_revoked = main.REVOKED_SESSIONS.copy()
        with tempfile.TemporaryDirectory() as directory:
            main.AUTH_DB_PATH = Path(directory) / "admin-test.sqlite3"
            with main.auth_db() as connection:
                connection.execute("INSERT INTO users (email, name, password_hash, role, status, created_at) VALUES (?, ?, ?, 'user', 'active', 1)", ("control-room@example.test", "Control Room User", main.hash_password("Password123")))
                connection.commit()
            token = main.create_session(os.environ["CHARGEFLOW_ADMIN_EMAIL"], "admin", "Configured admin")
            authorization = f"Bearer {token}"
            overview = main.admin_overview(authorization)
            self.assertGreaterEqual(overview["user_count"], 2)
            users = main.admin_users(authorization)
            self.assertTrue(any(user["email"] == "control-room@example.test" and user["source"] == "sqlite" for user in users))
            updated = main.admin_update_user_status("control-room@example.test", AccountStatusRequest(status="suspended"), authorization)
            self.assertEqual(updated["status"], "suspended")
            system = main.admin_system_status(authorization)
            self.assertTrue(system["database"]["exists"])
            self.assertEqual(system["dataset"]["stations"], len(STATIONS))
            with self.assertRaises(Exception):
                main.admin_change_password(AdminPasswordRequest(current_password="wrong", new_password="AnotherPassword123"), authorization)
            changed = main.admin_change_password(AdminPasswordRequest(current_password=os.environ["CHARGEFLOW_ADMIN_PASSWORD"], new_password="AnotherPassword123"), authorization)
            self.assertIn("updated", changed["message"])
            rotated_login = main.login(LoginRequest(email=os.environ["CHARGEFLOW_ADMIN_EMAIL"], password="AnotherPassword123"))
            self.assertEqual(rotated_login["role"], "admin")
        main.AUTH_DB_PATH = original_db_path
        main.SESSIONS.clear(); main.SESSIONS.update(original_sessions)
        main.REVOKED_SESSIONS.clear(); main.REVOKED_SESSIONS.update(original_revoked)


if __name__ == "__main__":
    unittest.main()
