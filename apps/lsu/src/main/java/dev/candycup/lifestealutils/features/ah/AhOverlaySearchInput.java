package dev.candycup.lifestealutils.features.ah;

//? if >1.21.8 {

import net.minecraft.client.input.CharacterEvent;
//?}

public interface AhOverlaySearchInput {
   //? if >1.21.8 {
   boolean lifestealutils$handleOverlayCharTyped(CharacterEvent characterEvent);
   //?} else {
   /*boolean lifestealutils$handleOverlayCharTyped(char chr, int modifiers);
    *///?}
}
