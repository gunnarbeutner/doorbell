#pragma once

#include "audio_compat.h"
#include "esphome/core/component.h"
#include "esphome/components/binary_sensor/binary_sensor.h"
#include "esphome/components/button/button.h"
#include "esphome/components/select/select.h"
#include "esphome/components/sensor/sensor.h"
#include "esphome/components/switch/switch.h"

#include <cstdint>
#include <deque>
#include <string>

namespace esphome::firmware_test {

class FakeMediaPlayer;

struct TestCommand {
  std::string verb;
  std::string target;
  std::string value;
};

class FirmwareTestBridge final : public Component {
 public:
  void setup() override;
  void loop() override;
  float get_setup_priority() const override { return setup_priority::HARDWARE; }

  void set_ha_connected(binary_sensor::BinarySensor *v) { ha_connected_ = v; }
  void set_auto_open(switch_::Switch *v) { auto_open_ = v; }
  void set_force_chime(switch_::Switch *v) { force_chime_ = v; }
  void set_suppress_chime(switch_::Switch *v) { suppress_chime_ = v; }
  void set_next_greeting(select::Select *v) { next_greeting_ = v; }
  void set_play_welcome(button::Button *v) { play_welcome_ = v; }
  void set_welcome_and_open(button::Button *v) { welcome_and_open_ = v; }
  void set_door_open(button::Button *v) { door_open_ = v; }
  void set_vbus_sensor(sensor::Sensor *v) { vbus_sensor_ = v; }
  void set_house_ring(binary_sensor::BinarySensor *v) { house_ring_ = v; }
  void set_apartment_ring(binary_sensor::BinarySensor *v) { apartment_ring_ = v; }
  void set_chime_enabled(binary_sensor::BinarySensor *v) { chime_enabled_ = v; }
  void set_k5_sense(binary_sensor::BinarySensor *v) { k5_sense_ = v; }
  void set_physical_ptt(binary_sensor::BinarySensor *v) { physical_ptt_ = v; }
  void set_manual_passive_listen(binary_sensor::BinarySensor *v) { manual_passive_listen_ = v; }

  bool connect_runner();
  void advance(uint32_t ms);
  void write_gpio(uint8_t pin, bool value);
  bool read_gpio(uint8_t pin) const;
  void media_event(const char *state, const std::string &name, uint32_t duration_ms);
  void emit(const char *name, bool state);
  void set_media_player(FakeMediaPlayer *player) { media_player_ = player; }

  static uint64_t virtual_millis();
  static void set_virtual_millis(uint64_t value);

 protected:
  bool send_line_(const std::string &line);
  bool receive_at_();
  void parse_command_(const std::string &token);
  void dispatch_(const TestCommand &command);
  void attach_trace_callbacks_();

  int socket_fd_{-1};
  uint8_t raw_inputs_{0x0F};
  uint32_t adc_mv_{455};
  uint32_t published_adc_mv_{UINT32_MAX};
  uint64_t sequence_{0};
  std::deque<TestCommand> commands_;
  std::deque<std::pair<uint8_t, bool>> pending_writes_;

  binary_sensor::BinarySensor *ha_connected_{nullptr};
  switch_::Switch *auto_open_{nullptr};
  switch_::Switch *force_chime_{nullptr};
  switch_::Switch *suppress_chime_{nullptr};
  select::Select *next_greeting_{nullptr};
  button::Button *play_welcome_{nullptr};
  button::Button *welcome_and_open_{nullptr};
  button::Button *door_open_{nullptr};
  sensor::Sensor *vbus_sensor_{nullptr};
  binary_sensor::BinarySensor *house_ring_{nullptr};
  binary_sensor::BinarySensor *apartment_ring_{nullptr};
  binary_sensor::BinarySensor *chime_enabled_{nullptr};
  binary_sensor::BinarySensor *k5_sense_{nullptr};
  binary_sensor::BinarySensor *physical_ptt_{nullptr};
  binary_sensor::BinarySensor *manual_passive_listen_{nullptr};
  FakeMediaPlayer *media_player_{nullptr};
};

FirmwareTestBridge *get_bridge();
void set_bridge(FirmwareTestBridge *bridge);
void notify_gpio_inputs_changed(uint8_t old_mask, uint8_t new_mask);

}  // namespace esphome::firmware_test
