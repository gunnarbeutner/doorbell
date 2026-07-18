#include "fake_media_player.h"
#include "firmware_test.h"

#include "esphome/core/log.h"

#include <cstdlib>

namespace esphome::firmware_test {

static const char *const TAG = "firmware_test.media";

void FakeMediaPlayer::setup() {
  this->state = media_player::MEDIA_PLAYER_STATE_IDLE;
  this->publish_state();
  if (auto *bridge = get_bridge())
    bridge->set_media_player(this);
}

media_player::MediaPlayerTraits FakeMediaPlayer::get_traits() {
  media_player::MediaPlayerTraits traits;
  traits.add_feature_flags(media_player::MediaPlayerEntityFeature::STOP);
  return traits;
}

void FakeMediaPlayer::add_file(audio::AudioFile *file, const std::string &name, uint32_t duration_ms) {
  this->files_.push_back({file, name, duration_ms});
}

const FakeMediaPlayer::FileMetadata *FakeMediaPlayer::find_(audio::AudioFile *file) const {
  for (const auto &metadata : this->files_)
    if (metadata.file == file)
      return &metadata;
  return nullptr;
}

void FakeMediaPlayer::set_fault(const std::string &mode, const std::string &argument) {
  this->fault_mode_ = mode;
  this->fault_delay_ms_ = argument.empty() ? 0 : static_cast<uint32_t>(std::strtoul(argument.c_str(), nullptr, 10));
}

void FakeMediaPlayer::start_(const FileMetadata &metadata, bool announcement) {
  this->current_name_ = metadata.name;
  this->current_duration_ms_ = metadata.duration_ms;
  this->state = announcement ? media_player::MEDIA_PLAYER_STATE_ANNOUNCING
                             : media_player::MEDIA_PLAYER_STATE_PLAYING;
  this->publish_state();
  if (auto *bridge = get_bridge())
    bridge->media_event("START", metadata.name, metadata.duration_ms);

  if (this->fault_mode_ == "never")
    return;
  const uint32_t duration = this->fault_mode_ == "synthetic_idle" ? 1 : metadata.duration_ms;
  this->set_timeout("finish", duration, [this]() { this->stop_(); });
}

void FakeMediaPlayer::play_file(audio::AudioFile *file, bool announcement, bool enqueue) {
  (void) enqueue;
  const auto *metadata = this->find_(file);
  if (metadata == nullptr) {
    ESP_LOGE(TAG, "unknown AudioFile pointer");
    return;
  }
  this->cancel_timeout("finish");
  this->cancel_timeout("delayed_start");
  if (this->fault_mode_ == "delayed_start") {
    const FileMetadata copy = *metadata;
    this->set_timeout("delayed_start", this->fault_delay_ms_, [this, copy, announcement]() {
      this->start_(copy, announcement);
    });
  } else {
    this->start_(*metadata, announcement);
  }
}

void FakeMediaPlayer::stop_() {
  this->cancel_timeout("finish");
  this->cancel_timeout("delayed_start");
  this->state = media_player::MEDIA_PLAYER_STATE_IDLE;
  this->publish_state();
  if (auto *bridge = get_bridge())
    bridge->media_event("IDLE", this->current_name_, this->current_duration_ms_);
  this->current_name_.clear();
  this->current_duration_ms_ = 0;
}

void FakeMediaPlayer::control(const media_player::MediaPlayerCall &call) {
  if (call.get_volume().has_value()) {
    this->volume = call.get_volume().value();
    this->publish_state();
  }
  if (call.get_command().has_value() &&
      call.get_command().value() == media_player::MEDIA_PLAYER_COMMAND_STOP)
    this->stop_();
}

}  // namespace esphome::firmware_test
