{{- define "secret-broker.name" -}}
secret-broker
{{- end -}}

{{- define "secret-broker.fullname" -}}
{{- if .Values.fullnameOverride -}}
{{- .Values.fullnameOverride | trunc 63 | trimSuffix "-" -}}
{{- else -}}
{{- .Release.Name | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- end -}}

{{- define "secret-broker.labels" -}}
helm.sh/chart: {{ .Chart.Name }}-{{ .Chart.Version | replace "+" "_" }}
app.kubernetes.io/name: {{ include "secret-broker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
{{- end -}}

{{- define "secret-broker.selectorLabels" -}}
app.kubernetes.io/name: {{ include "secret-broker.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}

{{- define "secret-broker.serviceAccountName" -}}
{{- if .Values.serviceAccount.create -}}
{{ default (include "secret-broker.fullname" .) .Values.serviceAccount.name }}
{{- else -}}
{{ default "default" .Values.serviceAccount.name }}
{{- end -}}
{{- end -}}

{{- define "secret-broker.configName" -}}
{{ include "secret-broker.fullname" . }}-config
{{- end -}}

{{- define "secret-broker.secretName" -}}
{{- if .Values.secret.existingSecretName -}}
{{ .Values.secret.existingSecretName }}
{{- else -}}
{{ include "secret-broker.fullname" . }}-secret
{{- end -}}
{{- end -}}

{{- define "secret-broker.envFrom" -}}
- configMapRef:
    name: {{ include "secret-broker.configName" . }}
- secretRef:
    name: {{ include "secret-broker.secretName" . }}
{{- end -}}

{{- define "secret-broker.cloudSqlProxyContainer" -}}
- name: cloud-sql-proxy
  image: {{ include "secret-broker.imageReference" (list .Values.cloudSqlProxy.image .Values.familyImage.requireDigest) | quote }}
  imagePullPolicy: {{ .Values.cloudSqlProxy.image.pullPolicy }}
  args:
    - "--port={{ .Values.cloudSqlProxy.port }}"
    {{- range .Values.cloudSqlProxy.args }}
    - {{ . | quote }}
    {{- end }}
    - {{ required "cloudSqlProxy.instanceConnectionName is required when cloudSqlProxy.enabled=true" .Values.cloudSqlProxy.instanceConnectionName | quote }}
  securityContext:
    {{- toYaml .Values.cloudSqlProxy.securityContext | nindent 4 }}
  resources:
    {{- toYaml .Values.cloudSqlProxy.resources | nindent 4 }}
{{- end -}}

{{- define "secret-broker.roleImage" -}}
{{- $root := index . 0 -}}
{{- $roleValues := index . 1 -}}
{{- $roleName := index . 2 -}}
{{- $familyRepository := "" -}}
{{- $familyTag := "" -}}
{{- with $root.Values.familyImage -}}
{{- $familyRepository = .repository | default "" -}}
{{- $familyTag = .tag | default "" -}}
{{- end -}}
{{- if and $root.Values.familyImage.digest (not $familyRepository) -}}
{{- fail "familyImage.digest requires familyImage.repository" -}}
{{- end -}}
{{- $repository := default $roleValues.image.repository $familyRepository -}}
{{- $tag := default $roleValues.image.tag $familyTag -}}
{{- $digest := $roleValues.image.digest | default "" -}}
{{- if $familyRepository -}}{{- $digest = $root.Values.familyImage.digest | default "" -}}{{- end -}}
{{- $image := dict "repository" $repository "tag" $tag "digest" $digest "requireDigest" $roleValues.image.requireDigest -}}
{{- include "secret-broker.imageReference" (list $image $root.Values.familyImage.requireDigest) -}}
{{- end -}}

{{- define "secret-broker.roleImagePullPolicy" -}}
{{- $root := index . 0 -}}
{{- $roleValues := index . 1 -}}
{{- $familyPullPolicy := "" -}}
{{- with $root.Values.familyImage -}}
{{- $familyPullPolicy = .pullPolicy | default "" -}}
{{- end -}}
{{- default $roleValues.image.pullPolicy $familyPullPolicy -}}
{{- end -}}

{{- define "secret-broker.familyImageCommand" -}}
{{- $root := index . 0 -}}
{{- $roleValues := index . 1 -}}
{{- $roleName := index . 2 -}}
{{- $familyRepository := "" -}}
{{- with $root.Values.familyImage -}}
{{- $familyRepository = .repository | default "" -}}
{{- end -}}
{{- if $familyRepository -}}
{{- if not $roleValues.command -}}
{{- fail (printf "familyImage.repository requires secret-broker %s command; set %s.command to the binary path baked into the shared image" $roleName $roleName) -}}
{{- end -}}
command:
{{- toYaml $roleValues.command | nindent 2 }}
{{- end -}}
{{- end -}}

{{/* Render a reviewed repository/digest, requiring nested pins in private mode. */}}
{{- define "secret-broker.imageReference" -}}
{{- $image := index . 0 -}}
{{- $requireDigest := index . 1 -}}
{{- $repository := required "image.repository is required" $image.repository -}}
{{- if or (contains "@" $repository) (regexMatch "[:][^/]*$" $repository) (regexMatch "[[:space:]]" $repository) -}}
{{- fail "image.repository must not contain a tag, digest, or whitespace" -}}
{{- end -}}
{{- if $image.digest -}}
{{- if not (regexMatch "^sha256:[a-f0-9]{64}$" $image.digest) -}}
{{- fail "image.digest must be sha256 followed by 64 lowercase hexadecimal characters" -}}
{{- end -}}
{{- printf "%s@%s" $repository $image.digest -}}
{{- else -}}
{{- if or $requireDigest $image.requireDigest -}}{{- fail "image.digest is required in digest-only mode" -}}{{- end -}}
{{- printf "%s:%s" $repository (required "image.tag is required without image.digest" $image.tag) -}}
{{- end -}}
{{- end -}}
