package com.helloworld

import com.facebook.react.ReactPackage
import com.facebook.react.bridge.NativeModule
import com.facebook.react.bridge.ReactApplicationContext
import com.facebook.react.uimanager.ViewManager

/**
 * Registers Ink2Task's own native modules.
 *
 * IMPORTANT -- how this actually reaches the device: PluginHost does NOT use
 * MainApplication.getPackages() like a normal React Native app. It instantiates
 * only what is named in PluginConfig.json's "reactPackages" array. Our
 * buildPlugin.sh builds that array by scanning android/ for ReactPackage
 * implementations (find_packages_in_directory), so this should be discovered
 * automatically and appear as "com.helloworld.Ink2TaskPackage" alongside
 * "com.rnfs.RNFSPackage".
 *
 * If it does NOT appear there after a build, NativeModules.Ink2TaskOverlay will
 * be null in JS and every call silently no-ops -- the code compiles and the JS
 * runs, it just does nothing. So after building, check
 * build/generated/PluginConfig.json and confirm the name is in reactPackages.
 *
 * ⚠️ NAMING TRAP -- keep prose in this file free of the keyword that declares a
 * type, followed by a space. buildPlugin.sh derives the registered name with a
 * sed that captures the FIRST such occurrence in the whole file, comments
 * included, and stops there. An earlier draft of this very comment tripped it
 * and the build registered "com.helloworld.should" instead of the real name --
 * a bogus entry that leaves the module unregistered while everything still
 * compiles and runs. Verify after each build that the correct name appears in
 * build/generated/PluginConfig.json, and keep the declaration in the scanner's
 * expected shape (`Name : ReactPackage`).
 */
class Ink2TaskPackage : ReactPackage {
    override fun createNativeModules(
        reactContext: ReactApplicationContext,
    ): List<NativeModule> = listOf(Ink2TaskOverlayModule(reactContext))

    override fun createViewManagers(
        reactContext: ReactApplicationContext,
    ): List<ViewManager<*, *>> = emptyList()
}
