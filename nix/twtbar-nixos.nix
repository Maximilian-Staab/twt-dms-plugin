# twtBar — DankMaterialShell plugin, deployed system-wide.
#
# DMS's PluginService scans /etc/xdg/quickshell/dms-plugins (system) and
# ~/.config/DankMaterialShell/plugins (user) for plugin directories.
# Deploying via environment.etc places a symlink at
# /etc/xdg/quickshell/dms-plugins/twtBar -> store path, making the plugin
# available to all users' DMS sessions without per-user setup.
#
# The plugin is the repo root (plugin.json and the QML/JS/Python files live
# there); the store copy also carries the flake, tests and docs, which DMS
# ignores. Runtime requirements: curl and python3 on DMS's PATH (TwtApi.js /
# TwtAuth.js shell out via Quickshell.Io Process).
{
  config,
  lib,
  ...
}:

let
  cfg = config.programs.twt.twtBar;
in
{
  options.programs.twt.twtBar = {
    enable = lib.mkEnableOption "twtBar (system-wide DMS plugin)";
  };

  config = lib.mkIf cfg.enable {
    environment.etc."xdg/quickshell/dms-plugins/twtBar".source = ../.;
  };
}
