#include "firmware_test.h"
#include "fake_media_player.h"

#include "esphome/core/application.h"
#include "esphome/core/log.h"

#include <cerrno>
#include <cstdlib>
#include <cstring>
#include <sstream>
#include <sys/socket.h>
#include <sys/un.h>
#include <unistd.h>

namespace esphome::firmware_test {

static const char *const TAG = "firmware_test";
static FirmwareTestBridge *s_bridge = nullptr;
static uint64_t s_virtual_millis = 0;

FirmwareTestBridge *get_bridge() { return s_bridge; }
void set_bridge(FirmwareTestBridge *bridge) { s_bridge = bridge; }
uint64_t FirmwareTestBridge::virtual_millis() { return s_virtual_millis; }
void FirmwareTestBridge::set_virtual_millis(uint64_t value) { s_virtual_millis = value; }

bool FirmwareTestBridge::send_line_(const std::string &line) {
  const char *data = line.data();
  size_t remaining = line.size();
  while (remaining != 0) {
    const ssize_t sent = ::send(this->socket_fd_, data, remaining, 0);
    if (sent < 0 && errno == EINTR)
      continue;
    if (sent <= 0)
      return false;
    data += sent;
    remaining -= static_cast<size_t>(sent);
  }
  return true;
}

bool FirmwareTestBridge::connect_runner() {
  const char *path = std::getenv("DOORBELL_FIRMWARE_TEST_SOCKET");
  if (path == nullptr || *path == '\0') {
    ESP_LOGE(TAG, "DOORBELL_FIRMWARE_TEST_SOCKET is not set");
    return false;
  }
  const char *initial = std::getenv("DOORBELL_FIRMWARE_TEST_START_MS");
  if (initial != nullptr)
    s_virtual_millis = std::strtoull(initial, nullptr, 10);

  this->socket_fd_ = ::socket(AF_UNIX, SOCK_STREAM, 0);
  if (this->socket_fd_ < 0)
    return false;
  sockaddr_un address{};
  address.sun_family = AF_UNIX;
  if (std::strlen(path) >= sizeof(address.sun_path)) {
    ESP_LOGE(TAG, "runner socket path is too long");
    return false;
  }
  std::strcpy(address.sun_path, path);
  if (::connect(this->socket_fd_, reinterpret_cast<sockaddr *>(&address), sizeof(address)) != 0) {
    ESP_LOGE(TAG, "connect(%s) failed: %s", path, std::strerror(errno));
    return false;
  }

  if (!this->send_line_(
          "HELLO 1 PTT_DRV=9 DOOR_DRV=10 MUTE_DRV=11 P4_SENSE_N=12 P5_SENSE_N=13 "
          "K5_SENSE_N=4 VBUS_F_ADC=5 PTT_SENSE_N=47 P4_ISO=48\n"))
    return false;
  if (!this->receive_at_())
    return false;
  for (const auto &write : this->pending_writes_)
    this->write_gpio(write.first, write.second);
  this->pending_writes_.clear();
  return true;
}

void FirmwareTestBridge::setup() {
  set_bridge(this);
  if (!this->connect_runner()) {
    this->mark_failed();
    std::exit(70);
  }
  this->attach_trace_callbacks_();
  const char *ha_connected = std::getenv("DOORBELL_FIRMWARE_TEST_HA_CONNECTED");
  this->ha_connected_->publish_state(ha_connected != nullptr &&
                                     (std::strcmp(ha_connected, "1") == 0 ||
                                      std::strcmp(ha_connected, "on") == 0));
  if (this->published_adc_mv_ == UINT32_MAX) {
    this->vbus_sensor_->publish_state(this->adc_mv_ * 0.011f);
    this->published_adc_mv_ = this->adc_mv_;
  }
}

void FirmwareTestBridge::attach_trace_callbacks_() {
  this->ha_connected_->add_on_state_callback([this](bool state) { this->emit("ha_connected", state); });
  this->house_ring_->add_on_state_callback([this](bool state) { this->emit("house_ring", state); });
  this->apartment_ring_->add_on_state_callback([this](bool state) { this->emit("apartment_ring", state); });
  this->chime_enabled_->add_on_state_callback([this](bool state) { this->emit("chime_enabled", state); });
  this->k5_sense_->add_on_state_callback([this](bool state) { this->emit("k5_sense", state); });
  this->physical_ptt_->add_on_state_callback([this](bool state) { this->emit("physical_ptt", state); });
  this->manual_passive_listen_->add_on_state_callback(
      [this](bool state) { this->emit("manual_passive_listen", state); });
}

void FirmwareTestBridge::parse_command_(const std::string &token) {
  TestCommand command;
  const size_t first = token.find(':');
  const size_t second = first == std::string::npos ? std::string::npos : token.find(':', first + 1);
  command.verb = token.substr(0, first);
  if (first != std::string::npos)
    command.target = token.substr(first + 1, second == std::string::npos ? second : second - first - 1);
  if (second != std::string::npos)
    command.value = token.substr(second + 1);
  this->commands_.push_back(std::move(command));
}

bool FirmwareTestBridge::receive_at_() {
  std::string line;
  char ch;
  while (true) {
    const ssize_t got = ::recv(this->socket_fd_, &ch, 1, 0);
    if (got < 0 && errno == EINTR)
      continue;
    if (got <= 0) {
      ESP_LOGE(TAG, "runner disconnected");
      std::exit(71);
    }
    if (ch == '\n')
      break;
    line.push_back(ch);
    if (line.size() > 16384) {
      ESP_LOGE(TAG, "oversized protocol line");
      std::exit(72);
    }
  }

  std::istringstream stream(line);
  std::string kind;
  unsigned version;
  unsigned inputs;
  std::string reason;
  unsigned command_count;
  uint64_t timestamp;
  if (!(stream >> kind >> version >> timestamp >> inputs >> this->adc_mv_ >> reason >> command_count) ||
      kind != "AT" || version != 1) {
    ESP_LOGE(TAG, "protocol mismatch: %s", line.c_str());
    std::exit(73);
  }
  s_virtual_millis = timestamp;
  const uint8_t old_inputs = this->raw_inputs_;
  this->raw_inputs_ = static_cast<uint8_t>(inputs);
  notify_gpio_inputs_changed(old_inputs, this->raw_inputs_);
  if (this->adc_mv_ != this->published_adc_mv_) {
    this->vbus_sensor_->publish_state(this->adc_mv_ * 0.011f);
    this->published_adc_mv_ = this->adc_mv_;
  }
  for (unsigned i = 0; i < command_count; ++i) {
    std::string token;
    if (!(stream >> token)) {
      ESP_LOGE(TAG, "AT command count mismatch");
      std::exit(74);
    }
    this->parse_command_(token);
  }
  return true;
}

void FirmwareTestBridge::advance(uint32_t ms) {
  if (this->socket_fd_ < 0) {
    if (ms != 0)
      s_virtual_millis += ms;
    return;
  }
  if (ms == 0)
    return;
  const uint64_t deadline = s_virtual_millis + ms;
  std::ostringstream line;
  line << "ADVANCE 1 " << s_virtual_millis << ' ' << deadline << "\n";
  if (!this->send_line_(line.str()) || !this->receive_at_())
    std::exit(75);
}

void FirmwareTestBridge::write_gpio(uint8_t pin, bool value) {
  if (this->socket_fd_ < 0) {
    this->pending_writes_.emplace_back(pin, value);
    return;
  }
  std::ostringstream line;
  line << "WRITE 1 " << s_virtual_millis << ' ' << ++this->sequence_ << ' ' << static_cast<unsigned>(pin) << ' '
       << (value ? 1 : 0) << "\n";
  if (!this->send_line_(line.str()))
    std::exit(76);
}

bool FirmwareTestBridge::read_gpio(uint8_t pin) const {
  switch (pin) {
    case 12:
      return (this->raw_inputs_ & 0x01) != 0;
    case 13:
      return (this->raw_inputs_ & 0x02) != 0;
    case 4:
      return (this->raw_inputs_ & 0x04) != 0;
    case 47:
      return (this->raw_inputs_ & 0x08) != 0;
    default:
      return false;
  }
}

void FirmwareTestBridge::media_event(const char *state, const std::string &name, uint32_t duration_ms) {
  if (this->socket_fd_ < 0)
    return;
  std::ostringstream line;
  line << "MEDIA 1 " << s_virtual_millis << ' ' << state << ' ' << (name.empty() ? "-" : name) << ' '
       << duration_ms << "\n";
  this->send_line_(line.str());
}

void FirmwareTestBridge::emit(const char *name, bool state) {
  if (this->socket_fd_ < 0)
    return;
  std::ostringstream line;
  line << "EMIT 1 " << s_virtual_millis << ' ' << name << ' ' << (state ? 1 : 0) << "\n";
  this->send_line_(line.str());
}

void FirmwareTestBridge::dispatch_(const TestCommand &command) {
  if (command.verb == "SET") {
    const bool value = command.value == "1" || command.value == "on";
    if (command.target == "ha")
      this->ha_connected_->publish_state(value);
    else if (command.target == "auto_open")
      value ? this->auto_open_->turn_on() : this->auto_open_->turn_off();
    else if (command.target == "force_chime")
      value ? this->force_chime_->turn_on() : this->force_chime_->turn_off();
    else if (command.target == "suppress_chime")
      value ? this->suppress_chime_->turn_on() : this->suppress_chime_->turn_off();
  } else if (command.verb == "SELECT") {
    auto call = this->next_greeting_->make_call();
    call.set_option(command.target);
    call.perform();
  } else if (command.verb == "PRESS") {
    if (command.target == "play")
      this->play_welcome_->press();
    else if (command.target == "welcome_open")
      this->welcome_and_open_->press();
    else if (command.target == "door")
      this->door_open_->press();
  } else if (command.verb == "GREET" || command.verb == "GREET_OPEN") {
    auto call = this->next_greeting_->make_call();
    call.set_option(command.target);
    call.perform();
    (command.verb == "GREET" ? this->play_welcome_ : this->welcome_and_open_)->press();
  } else if (command.verb == "MEDIA_FAULT" && this->media_player_ != nullptr) {
    this->media_player_->set_fault(command.target, command.value);
  } else if (command.verb == "CRASH") {
    std::_Exit(90);
  } else if (command.verb == "EXIT") {
    std::exit(0);
  } else {
    ESP_LOGE(TAG, "unknown test command %s:%s:%s", command.verb.c_str(), command.target.c_str(),
             command.value.c_str());
    std::exit(77);
  }
}

void FirmwareTestBridge::loop() {
  while (!this->commands_.empty()) {
    TestCommand command = std::move(this->commands_.front());
    this->commands_.pop_front();
    this->dispatch_(command);
  }
}

}  // namespace esphome::firmware_test
