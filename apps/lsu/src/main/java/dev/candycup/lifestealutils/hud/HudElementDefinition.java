package dev.candycup.lifestealutils.hud;

import net.minecraft.resources.Identifier;

import java.util.function.Supplier;

public record HudElementDefinition(
        Identifier id,
        String displayName,
        Supplier<String> miniMessageSupplier,
        HudPosition defaultPosition
) {
}
