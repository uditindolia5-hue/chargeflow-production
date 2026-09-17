import unittest

from backend.main import RecommendationRequest, STATIONS, network_summary, predict_wait, recommend


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


if __name__ == "__main__":
    unittest.main()
