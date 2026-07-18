#include "firmware_test.h"

#include "esphome/components/host/gpio.h"
#include "esphome/core/log.h"

namespace esphome::host {

struct ISRPinArg {
  uint8_t pin;
  bool inverted;
};

struct InterruptRegistration {
  void (*func)(void *){nullptr};
  void *arg{nullptr};
  gpio::InterruptType type{gpio::INTERRUPT_ANY_EDGE};
  bool inverted{false};
};

static InterruptRegistration s_interrupts[64]{};

ISRInternalGPIOPin HostGPIOPin::to_isr() const {
  return ISRInternalGPIOPin(new ISRPinArg{this->pin_, this->inverted_});
}
void HostGPIOPin::attach_interrupt(void (*func)(void *), void *arg, gpio::InterruptType type) const {
  if (this->pin_ < 64)
    s_interrupts[this->pin_] = {func, arg, type, this->inverted_};
}
void HostGPIOPin::pin_mode(gpio::Flags flags) { this->flags_ = flags; }
size_t HostGPIOPin::dump_summary(char *buffer, size_t len) const {
  return snprintf(buffer, len, "GPIO%u", this->pin_);
}
bool HostGPIOPin::digital_read() {
  auto *bridge = firmware_test::get_bridge();
  const bool physical = bridge == nullptr ? true : bridge->read_gpio(this->pin_);
  const bool logical = physical != this->inverted_;
  static bool seen[64]{};
  static bool previous[64]{};
  if (bridge != nullptr && this->pin_ < 64 && (!seen[this->pin_] || previous[this->pin_] != logical)) {
    seen[this->pin_] = true;
    previous[this->pin_] = logical;
    char name[16];
    snprintf(name, sizeof(name), "raw_gpio%u", this->pin_);
    bridge->emit(name, logical);
  }
  return logical;
}
void HostGPIOPin::digital_write(bool value) {
  if (auto *bridge = firmware_test::get_bridge())
    bridge->write_gpio(this->pin_, value != this->inverted_);
}
void HostGPIOPin::detach_interrupt() const {
  if (this->pin_ < 64)
    s_interrupts[this->pin_] = {};
}

void notify_interrupt(uint8_t pin, bool old_physical, bool new_physical) {
  if (pin >= 64 || old_physical == new_physical)
    return;
  auto &registration = s_interrupts[pin];
  if (registration.func == nullptr)
    return;
  const bool old_logical = old_physical != registration.inverted;
  const bool new_logical = new_physical != registration.inverted;
  const bool wanted = registration.type == gpio::INTERRUPT_ANY_EDGE ||
                      (registration.type == gpio::INTERRUPT_RISING_EDGE && !old_logical && new_logical) ||
                      (registration.type == gpio::INTERRUPT_FALLING_EDGE && old_logical && !new_logical);
  if (wanted)
    registration.func(registration.arg);
}

}  // namespace esphome::host

namespace esphome::firmware_test {

void notify_gpio_inputs_changed(uint8_t old_mask, uint8_t new_mask) {
  struct InputBit {
    uint8_t pin;
    uint8_t bit;
  };
  static constexpr InputBit INPUTS[]{{12, 0x01}, {13, 0x02}, {4, 0x04}, {47, 0x08}};
  for (const auto &input : INPUTS)
    host::notify_interrupt(input.pin, (old_mask & input.bit) != 0, (new_mask & input.bit) != 0);
}

}  // namespace esphome::firmware_test

namespace esphome {

bool ISRInternalGPIOPin::digital_read() {
  auto *arg = reinterpret_cast<host::ISRPinArg *>(this->arg_);
  auto *bridge = firmware_test::get_bridge();
  const bool physical = bridge == nullptr ? true : bridge->read_gpio(arg->pin);
  return physical != arg->inverted;
}
void ISRInternalGPIOPin::digital_write(bool value) {
  auto *arg = reinterpret_cast<host::ISRPinArg *>(this->arg_);
  if (auto *bridge = firmware_test::get_bridge())
    bridge->write_gpio(arg->pin, value != arg->inverted);
}
void ISRInternalGPIOPin::clear_interrupt() {}

}  // namespace esphome
