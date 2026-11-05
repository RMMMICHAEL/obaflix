package com.nuvio.app.core.auth

import co.touchlab.kermit.Logger
import com.nuvio.app.core.storage.LocalAccountDataCleaner
import com.nuvio.app.core.storage.PlatformLocalAccountDataCleaner
import com.nuvio.app.features.profiles.ProfileRepository
import com.nuvio.app.integration.obaflix.ObaflixSession
import com.nuvio.app.integration.obaflix.ObaflixStoredSession
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * Obaflix fork: identity comes from the Obaflix backend session ([ObaflixSession]), never from
 * Nuvio Supabase. Signed-in users are published with `isAnonymous = true`, which is Nuvio's
 * existing "local account" mode: every Nuvio cloud path (profiles, sync, addons, membership)
 * already skips the network for it. Rights stay server-side; this state grants nothing.
 */
object AuthRepository {
    private val log = Logger.withTag("AuthRepository")

    private val _state = MutableStateFlow<AuthState>(AuthState.Loading)
    val state: StateFlow<AuthState> = _state.asStateFlow()

    private val _error = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = _error.asStateFlow()

    private var initialized = false

    fun initialize() {
        if (initialized) return
        initialized = true
        publish(ObaflixSession.restore())
    }

    private fun publish(session: ObaflixStoredSession?) {
        _state.value = if (session == null) {
            AuthState.Unauthenticated
        } else {
            AuthState.Authenticated(userId = session.userId, email = session.email, isAnonymous = true)
        }
        // The account's server-side list, history and "Continuar assistindo" are brought in (read-only, additive).
        session?.let { com.nuvio.app.integration.obaflix.ObaflixDataImport.schedule(it.userId) }
    }

    /** Obaflix requires an account; there is no anonymous access. */
    fun signInAnonymously() {
        _error.value = OBAFLIX_ACCOUNT_REQUIRED
    }

    /** Creates the account through the backend's own `/api/auth/cadastro` (all validation stays there), then signs in. */
    suspend fun signUpWithEmail(email: String, password: String): Result<Unit> {
        _error.value = null
        val failure = runCatching { ObaflixSession.signUp(email.trim(), password) }.getOrElse {
            if (it is CancellationException) throw it
            "Não foi possível criar a conta. Verifique a conexão e tente novamente."
        }
        if (failure != null) {
            _error.value = failure
            return Result.failure(IllegalStateException(failure))
        }
        return signInWithEmail(email.trim(), password)
    }

    /**
     * Asks the backend to e-mail a password-reset link (its own `/api/auth/recuperar`: same answer whether or not the
     * account exists, rate limited). Returns the message to show; it never says if the e-mail has an account.
     */
    suspend fun requestPasswordReset(email: String): String {
        val address = email.trim()
        if (!address.contains('@') || address.length > 254) return "Digite o e-mail da sua conta para receber o link."
        val body = kotlinx.serialization.json.buildJsonObject { put("email", kotlinx.serialization.json.JsonPrimitive(address)) }.toString()
        return try {
            when (ObaflixSession.postPublic("/api/auth/recuperar", body).first) {
                202 -> "Se houver uma conta com esse e-mail, enviamos um link para criar uma nova senha."
                429 -> "Muitas tentativas. Aguarde alguns minutos e tente novamente."
                else -> "Não foi possível enviar o link agora. Tente novamente mais tarde."
            }
        } catch (e: CancellationException) {
            throw e
        } catch (_: Exception) {
            "Sem conexão. Verifique a internet e tente novamente."
        }
    }

    suspend fun signInWithEmail(email: String, password: String): Result<Unit> = runCatching {
        _error.value = null
        val failure = ObaflixSession.signIn(email, password)
        if (failure != null) throw IllegalStateException(failure)
        finishObaflixSignIn()
    }.onFailure { e ->
        if (e is CancellationException) throw e
        log.w { "Obaflix sign-in failed: ${e::class.simpleName}" }
        _error.value = e.message ?: "Não foi possível entrar."
    }

    /** Google handoff (see [com.nuvio.app.integration.obaflix.ObaflixGoogleLogin]): same ownership rules as e-mail sign-in. */
    suspend fun signInWithGoogleTicket(ticket: String, verifier: String): Result<Unit> = runCatching {
        _error.value = null
        val failure = ObaflixSession.signInWithTicket(ticket, verifier)
        if (failure != null) throw IllegalStateException(failure)
        finishObaflixSignIn()
    }.onFailure { e ->
        if (e is CancellationException) throw e
        log.w { "Obaflix Google sign-in failed: ${e::class.simpleName}" }
        _error.value = e.message ?: "Não foi possível entrar."
    }

    private suspend fun finishObaflixSignIn() {
        val session = ObaflixSession.user
        if (session != null) {
            val decision = ownershipDecision(
                marker = AuthStorage.loadDataOwner(),
                profileCacheOwner = ProfileRepository.storedOwnerUserId(),
                userId = session.userId,
                hasData = PlatformLocalAccountDataCleaner.hasUserData(),
            )
            if (decision != DataOwnership.Keep) {
                // Device data is per account: another account never sees it. Unproven ownership is
                // backed up before the wipe, so nothing is lost without a trace.
                try {
                    if (decision == DataOwnership.QuarantineThenWipe) PlatformLocalAccountDataCleaner.quarantine()
                    LocalAccountDataCleaner.wipe()
                } catch (e: Throwable) {
                    ObaflixSession.signOut()
                    throw e
                }
                ObaflixSession.persist() // the wipe also clears the stored session
            }
            AuthStorage.saveDataOwner(session.userId)
        }
        publish(session)
    }

    suspend fun signOut(): Result<Unit> {
        _error.value = null
        com.nuvio.app.integration.obaflix.ObaflixDataImport.reset()
        ObaflixSession.signOut()
        AuthStorage.clearAnonymousUserId()
        // Local-only data is the only copy: it stays on the device for the same account and is
        // wiped at the next sign-in as a different account (see signInWithEmail).
        _state.value = AuthState.Unauthenticated
        return Result.success(Unit)
    }

    /** Called when an Obaflix API answers 401: the server revoked or expired the session. */
    suspend fun onObaflixSessionRejected() {
        if (_state.value is AuthState.Authenticated) signOut()
    }

    suspend fun prepareForServerSwitch(): Result<Unit> = signOut()

    fun reinitialize() {
        initialized = false
        _state.value = AuthState.Loading
        initialize()
    }

    /** Nuvio cloud is disabled in this fork, so its errors never invalidate the Obaflix session. */
    @Suppress("UNUSED_PARAMETER")
    suspend fun signOutIfSessionInvalid(error: Throwable, source: String): Boolean = false

    suspend fun deleteAccount(): Result<Unit> {
        _error.value = OBAFLIX_DELETE_ON_WEB
        return Result.failure(IllegalStateException(OBAFLIX_DELETE_ON_WEB))
    }

    fun clearError() {
        _error.value = null
    }

    internal enum class DataOwnership { Keep, Wipe, QuarantineThenWipe }

    /**
     * Keep only when every known owner is [userId]. Two disagreeing owners, or none with data
     * present, mean ownership is unproven: back up, then wipe. A single other owner is proven.
     */
    internal fun ownershipDecision(marker: String?, profileCacheOwner: String?, userId: String, hasData: Boolean): DataOwnership {
        val owners = listOfNotNull(marker, profileCacheOwner).filter { it.isNotBlank() }.distinct()
        return when {
            owners.isEmpty() -> if (hasData) DataOwnership.QuarantineThenWipe else DataOwnership.Keep
            owners.size > 1 -> DataOwnership.QuarantineThenWipe
            owners.single() == userId -> DataOwnership.Keep
            else -> DataOwnership.Wipe
        }
    }

    private const val OBAFLIX_ACCOUNT_REQUIRED = "Entre com sua conta Obaflix para continuar."
    private const val OBAFLIX_DELETE_ON_WEB = "A exclusão de conta é feita no site do Obaflix, em Excluir conta."
}
