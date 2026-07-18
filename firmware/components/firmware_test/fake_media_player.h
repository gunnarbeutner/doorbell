#pragma once

#include "audio_compat.h"
#include "esphome/core/component.h"
#include "esphome/components/media_player/media_player.h"

#include <string>
#include <vector>

namespace esphome::firmware_test {

class FakeMediaPlayer final : public Component, public media_player::MediaPlayer {
 public:
  void setup() override;
  media_player::MediaPlayerTraits get_traits() override;
  void add_file(audio::AudioFile *file, const std::string &name, uint32_t duration_ms);
  void play_file(audio::AudioFile *file, bool announcement, bool enqueue);
  void set_fault(const std::string &mode, const std::string &argument);

 protected:
  struct FileMetadata {
    audio::AudioFile *file;
    std::string name;
    uint32_t duration_ms;
  };
  void control(const media_player::MediaPlayerCall &call) override;
  void start_(const FileMetadata &metadata, bool announcement);
  void stop_();
  const FileMetadata *find_(audio::AudioFile *file) const;

  std::vector<FileMetadata> files_;
  std::string fault_mode_{"normal"};
  uint32_t fault_delay_ms_{0};
  std::string current_name_;
  uint32_t current_duration_ms_{0};
};

}  // namespace esphome::firmware_test
