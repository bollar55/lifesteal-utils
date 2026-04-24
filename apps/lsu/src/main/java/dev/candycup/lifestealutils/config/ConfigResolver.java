package dev.candycup.lifestealutils.config;

import dev.candycup.lifestealutils.Config;
import dev.candycup.lifestealutils.FeatureFlagController;
import dev.candycup.lifestealutils.LifestealUtils;
import dev.candycup.configura.ui.ConfiguraConfigModel;
import dev.candycup.configura.ui.ConfiguraConfigScreen;
import dev.candycup.configura.core.ToggleGroup;
import dev.candycup.lifestealutils.config.configurables.ConfigurableBoolean;
import dev.candycup.lifestealutils.config.configurables.ConfigurableEnum;
import dev.candycup.lifestealutils.config.configurables.ConfigurableFloat;
import dev.candycup.lifestealutils.config.configurables.ConfigurableList;
import dev.candycup.lifestealutils.config.configurables.ConfigurableMinimessage;
import dev.candycup.lifestealutils.config.configurables.ConfigurableString;
import dev.candycup.lifestealutils.config.configurables.ConfigurableToggleGroup;
import dev.candycup.lifestealutils.interapi.MessagingUtils;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.lang.reflect.Modifier;
import java.util.ArrayList;
import java.util.Collections;
import java.util.Comparator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.function.Consumer;
import java.util.function.Supplier;

public final class ConfigResolver {
   private static final Logger LOGGER = LoggerFactory.getLogger("lifestealutils/config-resolver");
   private static volatile Map<String, RemoteOverrideDecision> remoteOverridesByKey = Collections.emptyMap();

   private ConfigResolver() {
   }

   public static Screen resolveScreen(Screen parent) {
      ConfigDescriptorRegistry.registerDefaultProviders();
      ConfiguraConfigModel.ResolvedConfig resolved = resolve(ConfigContainerRegistry.getRegisteredContainers());
      return new ConfiguraConfigScreen(parent, resolved);
   }

   public static void applyRemoteOverridesAtLoad() {
      ConfigDescriptorRegistry.registerDefaultProviders();
      Map<String, ConfigurationOption> optionsByKey = collectOptionsByKey(ConfigContainerRegistry.getRegisteredContainers());
      resolveRemoteOverrides(optionsByKey, true);
   }

   private static ConfiguraConfigModel.ResolvedConfig resolve(List<Class<?>> configClasses) {
      Map<String, ConfigurationOption> optionsByKey = collectOptionsByKey(configClasses);
      resolveRemoteOverrides(optionsByKey, false);

      Map<String, ConfiguraConfigModel.UiCategory> categoriesByName = new LinkedHashMap<>();
      for (ConfigurationOption option : optionsByKey.values()) {
         addOption(categoriesByName, option);
      }

      List<ConfiguraConfigModel.UiCategory> categories = new ArrayList<>(categoriesByName.values());
      categories.sort(Comparator
              .comparingInt((ConfiguraConfigModel.UiCategory category) -> LifestealUtils.getConfigCategoryWeight(category.id()))
              .thenComparing(ConfiguraConfigModel.UiCategory::id));
      categories.forEach(category -> category.features().sort(Comparator.comparing(ConfiguraConfigModel.UiFeature::id)));
      return new ConfiguraConfigModel.ResolvedConfig(
              Component.translatable("lsu.config.title"),
              categories,
              Config.HANDLER::save,
              () -> MessagingUtils.showMiniMessage("<green>Saved Lifesteal Utils config.</green>")
      );
   }

   private static void addOption(Map<String, ConfiguraConfigModel.UiCategory> categoriesByName, ConfigurationOption option) {
      ConfiguraConfigModel.UiCategory category = categoriesByName.computeIfAbsent(option.category, key ->
              new ConfiguraConfigModel.UiCategory(
                      key,
                      Component.translatable("lsu.config.%s".formatted(key.toLowerCase(Locale.ROOT))),
                      new ArrayList<>()
              ));

      ConfiguraConfigModel.UiFeature feature = category.features().stream()
              .filter(existing -> Objects.equals(existing.id(), option.group))
              .findFirst()
              .orElseGet(() -> {
                 ConfiguraConfigModel.UiFeature created = new ConfiguraConfigModel.UiFeature(
                         option.group,
                         Component.translatable("lsu.config.%s.%s".formatted(
                                 option.category.toLowerCase(Locale.ROOT),
                                 option.group.toLowerCase(Locale.ROOT)
                         )),
                         new ArrayList<>()
                 );
                 category.features().add(created);
                 return created;
              });

      feature.configurables().add(option.toUiConfigurable());
      feature.configurables().sort(Comparator.comparing(ConfiguraConfigModel.UiConfigurable::id));
   }

   private static Map<String, ConfigurationOption> collectOptionsByKey(List<Class<?>> configClasses) {
      Map<String, ConfigurationOption> optionsByKey = new LinkedHashMap<>();

      for (Class<?> configClass : configClasses) {
         for (Field field : configClass.getDeclaredFields()) {
            ConfigurationOption option = optionFromStaticField(field);
            if (option == null) {
               continue;
            }
            optionsByKey.put(option.key, option);
         }
      }

      List<ConfigOptionDescriptor<?>> dynamicOptions = new ArrayList<>();
      ConfigOptionCollector collector = dynamicOptions::add;
      for (ConfigOptionProvider provider : ConfigDescriptorRegistry.getProviders()) {
         provider.registerOptions(collector);
      }

      for (ConfigOptionDescriptor<?> descriptor : dynamicOptions) {
         ConfigurationOption option = descriptorToOption(descriptor);
         optionsByKey.put(option.key, option);
      }

      return optionsByKey;
   }

   private static void resolveRemoteOverrides(Map<String, ConfigurationOption> optionsByKey, boolean applyValues) {
      FeatureFlagController.RuntimeInfo runtimeInfo = FeatureFlagController.getRuntimeInfo();
      List<FeatureFlagController.RemoteConfigRule> rules = FeatureFlagController.getRemoteConfigRules();
      Map<String, RemoteOverrideDecision> decisions = new LinkedHashMap<>();

      for (FeatureFlagController.RemoteConfigRule rule : rules) {
         if (!rule.matches(runtimeInfo)) {
            continue;
         }

         ConfigurationOption option = optionsByKey.get(rule.applyForKey());
         if (option == null) {
            LOGGER.warn("[lsu-config] remote rule references unknown key '{}'", rule.applyForKey());
            continue;
         }

         Object coercedValue = option.coerceRemoteValue(rule.forceState());
         if (coercedValue == null) {
            LOGGER.warn("[lsu-config] remote rule rejected for key '{}' due to invalid forceState type/value", rule.applyForKey());
            continue;
         }

         RemoteOverrideDecision candidate = new RemoteOverrideDecision(
                 option.key,
                 coercedValue,
                 rule.reason(),
                 rule.priority(),
                 rule.order()
         );

         RemoteOverrideDecision current = decisions.get(option.key);
         if (current == null || candidate.priority > current.priority
                 || (candidate.priority == current.priority && candidate.order >= current.order)) {
            decisions.put(option.key, candidate);
         }
      }

      remoteOverridesByKey = Collections.unmodifiableMap(decisions);
      for (ConfigurationOption option : optionsByKey.values()) {
         option.remoteOverride = decisions.get(option.key);
      }

      if (applyValues) {
         Config.runWithRemoteOverrideApplication(() -> {
            for (RemoteOverrideDecision decision : decisions.values()) {
               ConfigurationOption option = optionsByKey.get(decision.key);
               if (option != null) {
                  option.applyRemoteValue(decision.forcedValue);
               }
            }
         });
      }
   }

   private static ConfigurationOption optionFromStaticField(Field field) {
      if (!Modifier.isStatic(field.getModifiers())) {
         return null;
      }

      ConfigurableBoolean configurableBoolean = field.getAnnotation(ConfigurableBoolean.class);
      ConfigurableString configurableString = field.getAnnotation(ConfigurableString.class);
      ConfigurableMinimessage configurableMinimessage = field.getAnnotation(ConfigurableMinimessage.class);
      ConfigurableFloat configurableFloat = field.getAnnotation(ConfigurableFloat.class);
      ConfigurableEnum configurableEnum = field.getAnnotation(ConfigurableEnum.class);
      ConfigurableList configurableList = field.getAnnotation(ConfigurableList.class);
      ConfigurableToggleGroup configurableToggleGroup = field.getAnnotation(ConfigurableToggleGroup.class);
      if (configurableBoolean == null && configurableString == null && configurableMinimessage == null
              && configurableFloat == null && configurableEnum == null && configurableList == null
              && configurableToggleGroup == null) {
         return null;
      }

      String location = configurableBoolean != null ? configurableBoolean.location()
              : configurableString != null ? configurableString.location()
              : configurableMinimessage != null ? configurableMinimessage.location()
              : configurableFloat != null ? configurableFloat.location()
              : configurableEnum != null ? configurableEnum.location()
              : configurableList != null ? configurableList.location()
              : configurableToggleGroup.location();

       ConfiguraConfigModel.OptionType optionType = configurableBoolean != null ? ConfiguraConfigModel.OptionType.BOOLEAN
               : configurableString != null ? ConfiguraConfigModel.OptionType.STRING
               : configurableMinimessage != null ? ConfiguraConfigModel.OptionType.MINIMESSAGE
               : configurableFloat != null ? ConfiguraConfigModel.OptionType.FLOAT
               : configurableEnum != null ? ConfiguraConfigModel.OptionType.ENUM
               : configurableList != null ? ConfiguraConfigModel.OptionType.LIST
               : ConfiguraConfigModel.OptionType.TOGGLE_GROUP;

      String[] segments = location.split("\\.");
       boolean listType = optionType == ConfiguraConfigModel.OptionType.LIST;
      if (listType && segments.length != 2) {
         throw new IllegalArgumentException("invalid list location '%s' on field '%s', expected category.group".formatted(location, field.getName()));
      }
      if (!listType && segments.length != 3) {
         throw new IllegalArgumentException("invalid configurable location '%s' on field '%s', expected category.group.entry".formatted(location, field.getName()));
      }

      try {
         field.setAccessible(true);
         Object defaultValue = field.get(null);

         ConfigurationOption option = new ConfigurationOption();
         option.category = segments[0];
         option.group = segments[1];
         option.name = listType ? segments[1] : segments[2];
         option.key = canonicalKey(option.category, option.group, option.name);
         option.defaultValue = listType ? new ArrayList<>((List<String>) defaultValue) : defaultValue;
         option.type = optionType;
          option.listEntry = listType;
          option.enumClass = field.getType().isEnum() ? (Class<? extends Enum<?>>) field.getType() : null;
          option.valueSupplier = () -> readStaticValue(field);
          option.valueConsumer = value -> writeStaticValue(field, value);
          if (option.type == ConfiguraConfigModel.OptionType.FLOAT && configurableFloat != null) {
             option.floatMin = configurableFloat.min();
             option.floatMax = configurableFloat.max();
             option.hasFloatBounds = true;
          }
          if (option.type == ConfiguraConfigModel.OptionType.TOGGLE_GROUP && defaultValue instanceof ToggleGroup tg) {
             option.toggleSchema = tg.schema();
          }
          String iconKey = configurableBoolean != null ? configurableBoolean.icon()
                  : configurableString != null ? configurableString.icon()
                  : configurableMinimessage != null ? configurableMinimessage.icon()
                  : configurableFloat != null ? configurableFloat.icon()
                  : configurableEnum != null ? configurableEnum.icon()
                  : configurableList != null ? configurableList.icon()
                  : configurableToggleGroup.icon();
          option.iconSupplier = iconSupplierForOption(iconKey, option.type);
          return option;
      } catch (IllegalAccessException exception) {
         throw new IllegalStateException("failed to read configurable field '%s'".formatted(field.getName()), exception);
      }
   }

   private static ConfigurationOption descriptorToOption(ConfigOptionDescriptor<?> descriptor) {
      ConfigurationOption option = new ConfigurationOption();
      option.category = descriptor.category();
      option.group = descriptor.group();
      option.name = descriptor.name();
      option.key = canonicalKey(option.category, option.group, option.name);
      option.defaultValue = descriptor.kind() == ConfigOptionDescriptor.Kind.LIST
              ? new ArrayList<>((List<String>) descriptor.defaultSupplier().get())
              : descriptor.defaultSupplier().get();
      option.type = switch (descriptor.kind()) {
         case BOOLEAN -> ConfiguraConfigModel.OptionType.BOOLEAN;
         case STRING -> ConfiguraConfigModel.OptionType.STRING;
         case MINIMESSAGE -> ConfiguraConfigModel.OptionType.MINIMESSAGE;
         case FLOAT -> ConfiguraConfigModel.OptionType.FLOAT;
         case ENUM -> ConfiguraConfigModel.OptionType.ENUM;
         case LIST -> ConfiguraConfigModel.OptionType.LIST;
      };
      option.listEntry = descriptor.kind() == ConfigOptionDescriptor.Kind.LIST;
      option.enumClass = descriptor.kind() == ConfigOptionDescriptor.Kind.ENUM
              ? (Class<? extends Enum<?>>) descriptor.enumClass()
              : null;
      option.valueSupplier = descriptor.valueSupplier();
      option.valueConsumer = descriptor.valueConsumer();
      option.hardName = descriptor.hardName().orElse(null);
      option.hardDescription = descriptor.hardDescription().orElse(null);
      option.iconSupplier = descriptor.iconSupplier().orElseGet(() -> defaultIconSupplier(option.type));
      return option;
   }

   private static String canonicalKey(String category, String group, String name) {
      return "%s.%s.%s".formatted(
              category.toLowerCase(Locale.ROOT),
              group.toLowerCase(Locale.ROOT),
              name.toLowerCase(Locale.ROOT)
      );
   }

   private static Object readStaticValue(Field field) {
      try {
         return field.get(null);
      } catch (IllegalAccessException exception) {
         throw new IllegalStateException("failed to read configurable field '%s'".formatted(field.getName()), exception);
      }
   }

   private static void writeStaticValue(Field field, Object value) {
      try {
         field.set(null, value);
      } catch (IllegalAccessException exception) {
         throw new IllegalStateException("failed to write configurable field '%s'".formatted(field.getName()), exception);
      }
   }

   private static Supplier<ItemStack> iconSupplierForOption(String explicitIconKey, ConfiguraConfigModel.OptionType type) {
      if (explicitIconKey == null || explicitIconKey.isBlank()) {
         return defaultIconSupplier(type);
      }
      try {
         String path = explicitIconKey;
         int colonIndex = path.indexOf(':');
         if (colonIndex >= 0 && colonIndex + 1 < path.length()) {
            path = path.substring(colonIndex + 1);
         }
         String fieldName = path.toUpperCase(Locale.ROOT).replace('-', '_').replace(' ', '_');
         java.lang.reflect.Field itemsField = Items.class.getField(fieldName);
         Object raw = itemsField.get(null);
         if (raw instanceof Item item) {
            ItemStack stack = new ItemStack(item);
            if (!stack.isEmpty()) {
               return () -> stack.copy();
            }
         }
      } catch (Exception ignored) {
      }
      return defaultIconSupplier(type);
   }

   private static Supplier<ItemStack> defaultIconSupplier(ConfiguraConfigModel.OptionType type) {
      ItemStack icon = switch (type) {
         case BOOLEAN -> new ItemStack(Items.LEVER);
         case STRING -> new ItemStack(Items.NAME_TAG);
         case MINIMESSAGE -> new ItemStack(Items.WRITABLE_BOOK);
         case FLOAT -> new ItemStack(Items.COMPASS);
         case ENUM -> new ItemStack(Items.COMPARATOR);
         case LIST -> new ItemStack(Items.BOOK);
         case TOGGLE_GROUP -> new ItemStack(Items.LEVER);
      };
      return () -> icon.copy();
   }

   private static final class ConfigurationOption {
      String category;
      String group;
      String name;
      String key;
      Object defaultValue;
      ConfiguraConfigModel.OptionType type;
      Class<? extends Enum<?>> enumClass;
      boolean listEntry;
      String hardName;
      String hardDescription;
      float floatMin;
      float floatMax;
      boolean hasFloatBounds;
      List<ToggleGroup.ToggleEntry> toggleSchema;
      Supplier<?> valueSupplier;
      Consumer<?> valueConsumer;
      Supplier<ItemStack> iconSupplier;
      RemoteOverrideDecision remoteOverride;

      ConfiguraConfigModel.UiConfigurable toUiConfigurable() {
         boolean remotelyForced = remoteOverride != null;
         Supplier<?> readSupplier = remotelyForced ? () -> remoteOverride.forcedValue : valueSupplier;
         Consumer<Object> rawValueConsumer = (Consumer<Object>) valueConsumer;
         Consumer<Object> writeConsumer = remotelyForced
                 ? ignored -> rawValueConsumer.accept(remoteOverride.forcedValue)
                 : rawValueConsumer;
         return new ConfiguraConfigModel.UiConfigurable(
                 key,
                 name,
                 type,
                 floatMin,
                 floatMax,
                 hasFloatBounds,
                 readSupplier,
                 writeConsumer,
                 () -> defaultValue,
                 resolveDisplayName(),
                 resolveDescription(),
                 remotelyForced,
                 resolveEnumValues(),
                 this::resolveEnumLabel,
                 iconSupplier == null ? () -> ItemStack.EMPTY : iconSupplier,
                 resolveToggleEntries()
         );
      }

      private Component resolveDisplayName() {
         if (hardName != null && !hardName.isBlank()) {
            return Component.literal(hardName);
         }
         if (type == ConfiguraConfigModel.OptionType.LIST) {
            return Component.translatable("lsu.config.%s.%s".formatted(
                    category.toLowerCase(Locale.ROOT),
                    group.toLowerCase(Locale.ROOT)
            ));
         }
         return Component.translatable("lsu.config.%s.%s.%s".formatted(
                 category.toLowerCase(Locale.ROOT),
                 group.toLowerCase(Locale.ROOT),
                 name.toLowerCase(Locale.ROOT)
         ));
      }

      private Component resolveDescription() {
         Component body;
         if (hardDescription != null && !hardDescription.isBlank()) {
            body = Component.literal(hardDescription);
         } else if (type == ConfiguraConfigModel.OptionType.LIST) {
            body = Component.translatable("lsu.config.%s.%s.desc".formatted(
                    category.toLowerCase(Locale.ROOT),
                    group.toLowerCase(Locale.ROOT)
            ));
         } else {
            body = Component.translatable("lsu.config.%s.%s.%s.desc".formatted(
                    category.toLowerCase(Locale.ROOT),
                    group.toLowerCase(Locale.ROOT),
                    name.toLowerCase(Locale.ROOT)
            ));
         }

         if (remoteOverride == null) {
            return body;
         }

         String reason = remoteOverride.reason;
         if (reason == null || reason.isBlank()) {
            reason = "This option is controlled by the remote registry.";
         }
         Component reasonComponent;
         try {
            reasonComponent = MessagingUtils.miniMessage(reason);
         } catch (Exception ignored) {
            reasonComponent = Component.literal(reason);
         }
         return Component.empty().append(body).append(Component.literal(" ")).append(reasonComponent);
      }

      private List<? extends Enum<?>> resolveEnumValues() {
         if (enumClass == null) {
            return List.of();
         }
         Object[] constants = enumClass.getEnumConstants();
         if (constants == null) {
            return List.of();
         }
         List<Enum<?>> values = new ArrayList<>();
         for (Object constant : constants) {
            values.add((Enum<?>) constant);
         }
         return values;
      }

      private Component resolveEnumLabel(Enum<?> enumValue) {
         try {
            Method getTranslationKey = enumValue.getClass().getMethod("getTranslationKey");
            if (getTranslationKey.getReturnType() == String.class) {
               String translationKey = (String) getTranslationKey.invoke(enumValue);
               if (translationKey != null && !translationKey.isBlank()) {
                  return Component.translatable(translationKey);
               }
            }
         } catch (Exception ignored) {
         }
         return Component.translatable("lsu.config.%s.%s.%s.%s".formatted(
                 category.toLowerCase(Locale.ROOT),
                 group.toLowerCase(Locale.ROOT),
                 name.toLowerCase(Locale.ROOT),
                 enumValue.name().toLowerCase(Locale.ROOT)
         ));
      }

      private List<ConfiguraConfigModel.UiToggleEntry> resolveToggleEntries() {
         if (type != ConfiguraConfigModel.OptionType.TOGGLE_GROUP || toggleSchema == null) {
            return List.of();
         }
         List<ConfiguraConfigModel.UiToggleEntry> result = new ArrayList<>();
         for (ToggleGroup.ToggleEntry entry : toggleSchema) {
            Component displayName = Component.translatable("lsu.config.%s.%s.%s".formatted(
                    category.toLowerCase(Locale.ROOT),
                    group.toLowerCase(Locale.ROOT),
                    entry.key().toLowerCase(Locale.ROOT)
            ));
            Supplier<ItemStack> icon = iconSupplierForOption(entry.icon(), ConfiguraConfigModel.OptionType.BOOLEAN);
            result.add(new ConfiguraConfigModel.UiToggleEntry(entry.key(), displayName, icon));
         }
         return result;
      }

      private Object coerceRemoteValue(Object rawValue) {
         if (rawValue == null) {
            return null;
         }
         return switch (type) {
            case BOOLEAN -> rawValue instanceof Boolean b ? b : null;
            case STRING, MINIMESSAGE -> rawValue instanceof String s ? s : null;
            case FLOAT -> coerceFloat(rawValue);
            case ENUM -> coerceEnum(rawValue);
            case LIST -> coerceStringList(rawValue);
            case TOGGLE_GROUP -> null;
         };
      }

      private Float coerceFloat(Object rawValue) {
         Float value = null;
         if (rawValue instanceof Number number) {
            value = number.floatValue();
         } else if (rawValue instanceof String stringValue) {
            try {
               value = Float.parseFloat(stringValue);
            } catch (NumberFormatException ignored) {
               return null;
            }
         }
         if (value == null) {
            return null;
         }
         if (hasFloatBounds) {
            value = Math.max(floatMin, Math.min(floatMax, value));
         }
         return value;
      }

      private Object coerceEnum(Object rawValue) {
         if (!(rawValue instanceof String enumName) || enumClass == null) {
            return null;
         }
         Object[] constants = enumClass.getEnumConstants();
         if (constants == null) {
            return null;
         }
         for (Object constant : constants) {
            Enum<?> enumValue = (Enum<?>) constant;
            if (enumValue.name().equalsIgnoreCase(enumName)) {
               return enumValue;
            }
         }
         return null;
      }

      private List<String> coerceStringList(Object rawValue) {
         if (!(rawValue instanceof List<?> list)) {
            return null;
         }
         List<String> values = new ArrayList<>();
         for (Object item : list) {
            if (!(item instanceof String text)) {
               return null;
            }
            values.add(text);
         }
         return values;
      }

      private void applyRemoteValue(Object coercedValue) {
         switch (type) {
            case BOOLEAN -> ((Consumer<Boolean>) valueConsumer).accept((Boolean) coercedValue);
            case STRING, MINIMESSAGE -> ((Consumer<String>) valueConsumer).accept((String) coercedValue);
            case FLOAT -> ((Consumer<Float>) valueConsumer).accept((Float) coercedValue);
            case ENUM -> ((Consumer<Enum<?>>) valueConsumer).accept((Enum<?>) coercedValue);
            case LIST -> ((Consumer<List<String>>) valueConsumer).accept(new ArrayList<>((List<String>) coercedValue));
            case TOGGLE_GROUP -> {} // remote override not supported for toggle groups
         }
      }
   }

   public static final class RemoteOverrideDecision {
      private final String key;
      private final Object forcedValue;
      private final String reason;
      private final int priority;
      private final int order;

      private RemoteOverrideDecision(String key, Object forcedValue, String reason, int priority, int order) {
         this.key = key;
         this.forcedValue = forcedValue;
         this.reason = reason;
         this.priority = priority;
         this.order = order;
      }
   }
}
