package com.nuvio.app.integration.obaflix

import com.nuvio.app.features.profiles.AvatarCatalogItem
import com.nuvio.app.features.profiles.ProfileRepository
import nuvio.composeapp.generated.resources.Res

/**
 * Obaflix accounts have no Nuvio cloud: profiles live on the device, tied to the Obaflix user id.
 * Every account gets one ready profile, so login never stops on a "create profile" screen.
 */
internal object ObaflixProfiles {
    /** Bundled CC0 avatars (composeResources/files/avatars, see LICENSE-AVATARS.txt). */
    val localAvatars: List<AvatarCatalogItem> by lazy {
        (1..12).map { n ->
            val nn = n.toString().padStart(2, '0')
            val id = "obaflix-$nn"
            AvatarCatalogItem(
                id = id,
                displayName = "Obaflix $n",
                category = "obaflix",
                sortOrder = n,
                localImageUrl = Res.getUri("files/avatars/obaflix_avatar_$nn.png"),
            )
        }
    }

    const val DEFAULT_AVATAR_ID = "obaflix-01"

    suspend fun ensureDefaultProfile(email: String?) {
        if (ProfileRepository.state.value.profiles.isNotEmpty()) return
        ProfileRepository.createProfile(
            name = defaultProfileName(email),
            avatarColorHex = "#E50914",
            avatarId = DEFAULT_AVATAR_ID,
        )
    }

    internal fun defaultProfileName(email: String?): String =
        email?.substringBefore('@')
            ?.split('.', '_', '-', '+')
            ?.firstOrNull { it.any(Char::isLetter) }
            ?.take(20)
            ?.replaceFirstChar { it.uppercase() }
            ?: "Perfil"
}
