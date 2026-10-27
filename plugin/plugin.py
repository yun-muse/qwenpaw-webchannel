# -*- coding: utf-8 -*-
"""WebChannel plugin entry point."""

import logging

try:
    from qwenpaw.plugins.api import PluginApi
except ImportError:  # standalone test environment without host package
    class PluginApi:  # type: ignore[no-redef]
        pass

logger = logging.getLogger(__name__)


def _patch_skill_whitelist() -> None:
    """Allow skills filtered for built-in 'console' channel on 'web' channel."""
    try:
        import qwenpaw.agents.skill_system.registry as skill_reg

        orig = getattr(skill_reg, "resolve_effective_skills", None)
        if callable(orig) and not getattr(skill_reg, "_webchannel_patched", False):
            def _wrapped_resolve(
                workspace_dir, channel_name="console", *args, **kwargs
            ):
                if channel_name == "web":
                    channel_name = "console"
                return orig(workspace_dir, channel_name, *args, **kwargs)

            skill_reg.resolve_effective_skills = _wrapped_resolve
            skill_reg._webchannel_patched = True
    except Exception:  # noqa: BLE001
        logger.debug("webchannel: skill whitelist patch skipped", exc_info=True)


class WebChannelPlugin:
    """Registers the self-hosted web channel with QwenPaw."""

    def register(self, api: PluginApi):
        """Register the WebChannel with its config fields."""
        _patch_skill_whitelist()
        try:  # package-relative when loaded as part of the plugin package
            from .channel import WebChannel
        except ImportError:  # loaded as a top-level module by the loader
            from channel import WebChannel

        api.register_channel(
            channel_class=WebChannel,
            label="Web",
            description=(
                "Self-hosted web frontend over the WebChannel relay "
                "(WebSocket, per-delta streaming)"
            ),
            config_fields=[
                {
                    "name": "relay_url",
                    "label": "Relay URL",
                    "type": "text",
                    "required": True,
                    "placeholder": "ws://127.0.0.1:8787/ws/agent",
                    "default": "ws://127.0.0.1:8787/ws/agent",
                },
                {
                    "name": "token",
                    "label": "Agent Token",
                    "type": "password",
                    "required": True,
                    "placeholder": "dev-agent-token",
                    "default": "dev-agent-token",
                },
                {
                    "name": "turso_url",
                    "label": "Turso DB URL",
                    "type": "text",
                    "required": False,
                    "placeholder": "libsql://webchannel-chats-<org>.turso.io",
                    "default": "",
                },
                {
                    "name": "turso_token",
                    "label": "Turso DB Token",
                    "type": "password",
                    "required": False,
                    "placeholder": "",
                    "default": "",
                },
            ],
        )
        logger.info("✓ WebChannel registered")


# Export plugin instance
plugin = WebChannelPlugin()
